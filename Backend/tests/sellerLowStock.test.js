import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb } from './helpers/db.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { listLowStockFoods } from '../src/modules/food/restaurant/services/restaurantFood.service.js';

/**
 * The seller's own low-stock screen.
 *
 * It used to require the product to carry its own lowStockThreshold, which
 * meant a shop that configured its thresholds once on the outlet -- the way
 * this is meant to be used -- opened an empty screen while its shelves ran
 * down. The threshold being optional is the feature; the screen ignoring the
 * ones that took the option was the bug.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

let STORE;

beforeEach(async () => {
    STORE = await FoodRestaurant.create({
        restaurantName: 'Corner Store',
        ownerName: 'Owner',
        ownerPhone: '9000000000',
        phone: '9000000000',
        status: 'approved',
        stockThresholds: { low: 10, critical: 3, out: 0 }
    });
});

const item = (over = {}) =>
    FoodItem.create({ restaurantId: STORE._id, name: 'Milk', price: 50, stockQty: 100, ...over });

describe('what the seller is shown', () => {
    it('includes a product that never set a threshold of its own', async () => {
        await item({ name: 'Inherits', stockQty: 4 });

        const { items } = await listLowStockFoods(String(STORE._id));
        assert.deepEqual(items.map((i) => i.name), ['Inherits']);
    });

    it('names the tier rather than lumping everything under "low"', async () => {
        await item({ name: 'Low', stockQty: 8 });
        await item({ name: 'Critical', stockQty: 2 });
        await item({ name: 'Gone', stockQty: 0 });

        const { items } = await listLowStockFoods(String(STORE._id));
        const byName = Object.fromEntries(items.map((i) => [i.name, i.stockBadge.tier]));
        assert.deepEqual(byName, { Low: 'low', Critical: 'critical', Gone: 'out' });
    });

    it('leaves out what is comfortably in stock', async () => {
        await item({ name: 'Plenty', stockQty: 500 });
        await item({ name: 'Low', stockQty: 4 });

        const { items, total } = await listLowStockFoods(String(STORE._id));
        assert.deepEqual(items.map((i) => i.name), ['Low']);
        assert.equal(total, 1);
    });

    it('leaves out a product nobody counts', async () => {
        // null stock is "not tracked", not "none left". Listing it as low would
        // send a seller looking for a shelf that is perfectly full.
        await item({ name: 'Untracked', stockQty: null });

        const { items } = await listLowStockFoods(String(STORE._id));
        assert.equal(items.length, 0);
    });

    it('honours a product that overrides the outlet', async () => {
        // Bought by the pallet: eight units is fine for this one even though
        // eight is low for everything else in the shop.
        await item({ name: 'Bulk', stockQty: 8, lowStockThreshold: 2 });

        const { items } = await listLowStockFoods(String(STORE._id));
        assert.equal(items.length, 0);
    });

    it('puts the emptiest shelf first', async () => {
        await item({ name: 'Eight', stockQty: 8 });
        await item({ name: 'One', stockQty: 1 });
        await item({ name: 'Four', stockQty: 4 });

        const { items } = await listLowStockFoods(String(STORE._id));
        assert.deepEqual(items.map((i) => i.name), ['One', 'Four', 'Eight']);
    });
});
