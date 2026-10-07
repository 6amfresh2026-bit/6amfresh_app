import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb } from './helpers/db.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { notifyStockTierChange } from '../src/modules/food/orders/services/stockAlert.service.js';
import { adjustStock } from '../src/modules/food/admin/services/stockAdmin.service.js';

/**
 * Low-stock alerting.
 *
 * The alert (push + email) fires off notifyStockTierChange, and only on a
 * *downward* tier crossing — once, when a shelf first falls into a worse band,
 * not on every sale that keeps it there. SMTP is never configured in the test
 * environment, so sendLowStockAlertEmail resolves to a no-op send; what these
 * tests pin down is the decision to alert and the crossing state it records,
 * which is the part my change depends on. The email body itself is covered,
 * SMTP-free, by scripts/lowStockEmail.selfcheck.mjs.
 *
 * They also guard the two admin paths that previously changed stock silently —
 * the manual Stocks screen now has to drive the same alert.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

let STORE;

beforeEach(async () => {
    STORE = await FoodRestaurant.create({
        restaurantName: 'Corner Store',
        ownerName: 'Owner',
        ownerEmail: 'owner@corner.test',
        ownerPhone: '9000000000',
        phone: '9000000000',
        status: 'approved',
        stockThresholds: { low: 10, critical: 3, out: 0 },
    });
});

const makeItem = (over = {}) =>
    FoodItem.create({ restaurantId: STORE._id, name: 'Milk', price: 50, stockQty: 100, ...over });

// notifyStockTierChange reads the item it is handed, the way the order path
// passes a freshly projected document. Re-read so stockAlert.lastTier reflects
// what the previous call persisted.
const reload = async (id) =>
    FoodItem.findById(id).select('stockQty name restaurantId sku price lowStockThreshold criticalStockThreshold outOfStockThreshold stockAlert').lean();

describe('notifyStockTierChange — when it alerts', () => {
    it('alerts on the first fall into the low band and records the tier', async () => {
        const item = await makeItem({ stockQty: 8 }); // below low (10), above critical (3)
        const result = await notifyStockTierChange(await reload(item._id));

        assert.ok(result, 'a downward crossing should return a result');
        assert.equal(result.from, 'in_stock');
        assert.equal(result.to, 'low');

        const after = await FoodItem.findById(item._id).lean();
        assert.equal(after.stockAlert.lastTier, 'low');
        assert.ok(after.stockAlert.lastNotifiedAt, 'an alert should stamp lastNotifiedAt');
    });

    it('alerts again when it falls further, low -> critical', async () => {
        const item = await makeItem({ stockQty: 8 });
        await notifyStockTierChange(await reload(item._id)); // -> low

        await FoodItem.updateOne({ _id: item._id }, { $set: { stockQty: 2 } });
        const result = await notifyStockTierChange(await reload(item._id));

        assert.equal(result?.to, 'critical');
    });

    it('alerts on hitting zero, with tier "out"', async () => {
        const item = await makeItem({ stockQty: 1 });
        await notifyStockTierChange(await reload(item._id)); // -> critical

        await FoodItem.updateOne({ _id: item._id }, { $set: { stockQty: 0 } });
        const result = await notifyStockTierChange(await reload(item._id));

        assert.equal(result?.to, 'out');
    });
});

describe('notifyStockTierChange — when it stays quiet', () => {
    it('does not alert while the tier is unchanged', async () => {
        const item = await makeItem({ stockQty: 8 });
        await notifyStockTierChange(await reload(item._id)); // -> low

        // another sale, still low
        await FoodItem.updateOne({ _id: item._id }, { $set: { stockQty: 7 } });
        const result = await notifyStockTierChange(await reload(item._id));

        assert.equal(result, null, 'same tier should not re-alert');
    });

    it('does not alert on restock — an upward move is good news', async () => {
        const item = await makeItem({ stockQty: 2 });
        await notifyStockTierChange(await reload(item._id)); // -> critical

        await FoodItem.updateOne({ _id: item._id }, { $set: { stockQty: 100 } });
        const result = await notifyStockTierChange(await reload(item._id));

        assert.equal(result, null, 'climbing back to in_stock must not alert');
        // but the baseline is reset, so the next fall alerts again
        const after = await FoodItem.findById(item._id).lean();
        assert.equal(after.stockAlert.lastTier, 'in_stock');
    });

    it('ignores an untracked product (null stock is "not counted")', async () => {
        const item = await makeItem({ stockQty: null });
        const result = await notifyStockTierChange(await reload(item._id));
        assert.equal(result, null);
    });

    it('honours a product that overrides the outlet threshold', async () => {
        // eight is fine for a pallet item even though eight is low shop-wide
        const item = await makeItem({ stockQty: 8, lowStockThreshold: 2 });
        const result = await notifyStockTierChange(await reload(item._id));
        assert.equal(result, null);
    });
});

describe('admin manual adjust drives the same alert', () => {
    const actor = { id: String(STORE?._id || ''), role: 'ADMIN', name: 'Admin' };

    it('records a low tier when a manual "remove" drops it below threshold', async () => {
        const item = await makeItem({ stockQty: 15 }); // in stock

        // remove 8 -> 7, which is below the low threshold of 10
        await adjustStock({ itemId: String(item._id), mode: 'remove', qty: 8 }, { id: 'admin1', role: 'ADMIN' });

        // notifyStockTierChange is fire-and-forget; give the microtask a tick
        await new Promise((r) => setTimeout(r, 50));

        const after = await FoodItem.findById(item._id).lean();
        assert.equal(after.stockQty, 7);
        assert.equal(after.stockAlert?.lastTier, 'low', 'manual removal should move the tier to low');
    });

    it('records "out" when a manual "set" takes it to zero', async () => {
        const item = await makeItem({ stockQty: 20 });

        await adjustStock({ itemId: String(item._id), mode: 'set', qty: 0 }, { id: 'admin1', role: 'ADMIN' });
        await new Promise((r) => setTimeout(r, 50));

        const after = await FoodItem.findById(item._id).lean();
        assert.equal(after.stockQty, 0);
        assert.equal(after.stockAlert?.lastTier, 'out');
    });

    it('does not move the tier when a manual add keeps it comfortably in stock', async () => {
        const item = await makeItem({ stockQty: 50 });

        await adjustStock({ itemId: String(item._id), mode: 'add', qty: 10 }, { id: 'admin1', role: 'ADMIN' });
        await new Promise((r) => setTimeout(r, 50));

        const after = await FoodItem.findById(item._id).lean();
        // either untouched or explicitly in_stock, never a false low/critical
        assert.notEqual(after.stockAlert?.lastTier, 'low');
        assert.notEqual(after.stockAlert?.lastTier, 'critical');
        assert.notEqual(after.stockAlert?.lastTier, 'out');
    });
});
