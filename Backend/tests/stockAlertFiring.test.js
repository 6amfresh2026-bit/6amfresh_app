import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb } from './helpers/db.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { reserveStockForItems } from '../src/modules/food/orders/services/inventory.service.js';

/**
 * Does the alert actually fire on a real sale?
 *
 * The tier rules are unit-tested on their own, but that proves nothing about
 * whether anything calls them: the hook lives on the atomic decrement in
 * reserveStockForItems, and it is fire-and-forget, so a mistake there would be
 * completely silent. These drive the genuine decrement and read back the tier
 * it recorded on the item.
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
        stockThresholds: { low: 10, critical: 3, out: 0 }
    });
});

const item = (over = {}) =>
    FoodItem.create({ restaurantId: STORE._id, name: 'Milk', price: 50, stockQty: 100, ...over });

const sell = async (doc, qty) => {
    await reserveStockForItems([{ itemId: String(doc._id), quantity: qty }], {});
    // The hook is deliberately not awaited by the sale, so give the
    // fire-and-forget write a turn before reading it back.
    await new Promise((r) => setTimeout(r, 120));
    return FoodItem.findById(doc._id).select('stockQty stockAlert').lean();
};

describe('a sale that drops an item into a worse tier', () => {
    it('records the tier it fell into', async () => {
        const doc = await item({ stockQty: 12 });
        const after = await sell(doc, 4);

        assert.equal(after.stockQty, 8);
        assert.equal(after.stockAlert.lastTier, 'low');
        assert.ok(after.stockAlert.lastNotifiedAt, 'a downward crossing is announced');
    });

    it('can skip a tier when the sale is big enough', async () => {
        const doc = await item({ stockQty: 40 });
        const after = await sell(doc, 39);

        assert.equal(after.stockAlert.lastTier, 'critical');
    });
});

describe('a sale that changes nothing', () => {
    it('leaves a comfortable item unannounced, and untouched', async () => {
        const doc = await item({ stockQty: 100 });
        const after = await sell(doc, 1);

        assert.equal(after.stockAlert?.lastNotifiedAt ?? null, null, 'nothing to tell anybody');
        // And the tier is not written back either. That is deliberate rather
        // than an oversight: recording "still in stock" would be an extra write
        // per line item on every order, on the hot path of every sale, to
        // record that nothing happened.
        assert.equal(after.stockAlert?.lastTier ?? null, null);
    });

    it('announces an already-low item only once, not on every sale', async () => {
        // The reason the tier is stored at all: a shop selling forty units of a
        // low item across a morning needs one notice, not forty.
        const doc = await item({ stockQty: 9 });
        const first = await sell(doc, 1);
        assert.equal(first.stockAlert.lastTier, 'low');
        const firstAt = first.stockAlert.lastNotifiedAt;
        assert.ok(firstAt);

        const second = await sell(doc, 1);
        assert.equal(second.stockAlert.lastTier, 'low');
        assert.equal(
            new Date(second.stockAlert.lastNotifiedAt).getTime(),
            new Date(firstAt).getTime(),
            'still low, so nothing new was sent'
        );
    });
});

describe('restocking', () => {
    it('resets the baseline so the next fall is announced again', async () => {
        const doc = await item({ stockQty: 9 });
        await sell(doc, 1);

        await FoodItem.updateOne({ _id: doc._id }, { $set: { stockQty: 100 } });
        const backUp = await sell(doc, 1);
        assert.equal(backUp.stockAlert.lastTier, 'in_stock', 'recovery is recorded quietly');

        const downAgain = await sell(doc, 92);
        assert.equal(downAgain.stockAlert.lastTier, 'low');
    });
});

describe('an item nobody counts', () => {
    it('is never announced', async () => {
        // Untracked stock is not zero stock, and a sale of it is not a shelf
        // running down.
        const doc = await item({ stockQty: null });
        const after = await sell(doc, 5);

        assert.equal(after.stockAlert?.lastTier ?? null, null);
    });
});
