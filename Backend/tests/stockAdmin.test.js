import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, expectError, resetDb, someId } from './helpers/db.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { FoodStockMovement } from '../src/modules/food/orders/models/stockMovement.model.js';
import * as stock from '../src/modules/food/admin/services/stockAdmin.service.js';

/**
 * The admin Stock screen and Stock Verification.
 *
 * Two things carry the weight here: an adjustment must never leave the shelf and
 * the ledger disagreeing, and completing a verification must write the counted
 * figure and explain the difference.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const admin = { userId: String(someId()), role: 'ADMIN' };

async function seedStore() {
    const store = await FoodRestaurant.create({
        restaurantName: 'Demo Store',
        ownerName: 'Demo Owner',
        ownerPhone: '9000000000',
        phone: '9000000000'
    });
    return store;
}

const makeItem = (store, over = {}) =>
    FoodItem.create({ restaurantId: store._id, name: 'Milk', price: 50, stockQty: 100, ...over });

describe('listStocks', () => {
    it('reports per-row quantities and totals across the whole filtered set', async () => {
        const store = await seedStore();
        await makeItem(store, { name: 'Milk', stockQty: 100, testingQty: 5 });
        await makeItem(store, { name: 'Bread', stockQty: 20, testingQty: 0 });
        await makeItem(store, { name: 'Untracked', stockQty: null });

        // limit 1 so the totals cannot be coming from the page.
        const res = await stock.listStocks({ restaurantId: String(store._id), limit: 1 });
        assert.equal(res.total, 3);
        assert.equal(res.stocks.length, 1);
        assert.equal(res.totals.totalAvailableQty, 120);
        assert.equal(res.totals.testingQty, 5);
    });

    it('classifies in-stock, low, critical, out and untracked', async () => {
        // `Low` used to hold 3 units and be classified low, because low was the
        // only tier below in-stock. With a critical tier in place -- platform
        // default 3 -- three units is genuinely critical, so it is now named
        // that. `Low` below sits at 4 to pin the boundary that did not move.
        const store = await seedStore();
        await makeItem(store, { name: 'Plenty', stockQty: 100, lowStockThreshold: 10 });
        await makeItem(store, { name: 'Low', stockQty: 4, lowStockThreshold: 5 });
        await makeItem(store, { name: 'Critical', stockQty: 3, lowStockThreshold: 5 });
        await makeItem(store, { name: 'Gone', stockQty: 0 });
        await makeItem(store, { name: 'Untracked', stockQty: null });

        const { stocks } = await stock.listStocks({ restaurantId: String(store._id), limit: 50 });
        const byName = Object.fromEntries(stocks.map((s) => [s.name, s.status]));
        assert.deepEqual(byName, {
            Plenty: 'in_stock',
            Low: 'low',
            Critical: 'critical',
            Gone: 'out',
            Untracked: 'untracked'
        });
    });
});

describe('adjustStock', () => {
    it('adds, removes and sets, writing a movement each time', async () => {
        const store = await seedStore();
        const item = await makeItem(store, { stockQty: 100 });

        await stock.adjustStock({ itemId: String(item._id), mode: 'add', qty: 10, reason: 'Purchase received' }, admin);
        await stock.adjustStock({ itemId: String(item._id), mode: 'remove', qty: 30, reason: 'Damaged' }, admin);
        const last = await stock.adjustStock({ itemId: String(item._id), mode: 'set', qty: 75, reason: 'Counting correction' }, admin);

        assert.equal(last.stockQty, 75);
        const moves = await FoodStockMovement.find({ itemId: item._id }).sort({ createdAt: 1 }).lean();
        assert.equal(moves.length, 3);
        assert.deepEqual(moves.map((m) => m.qtyChange), [10, -30, -5]);
        assert.deepEqual(moves.map((m) => m.qtyAfter), [110, 80, 75]);
        assert.equal(moves[0].createdBy.role, 'ADMIN');
    });

    it('refuses to remove more than is on the shelf', async () => {
        const store = await seedStore();
        const item = await makeItem(store, { stockQty: 5 });
        await expectError(
            () => stock.adjustStock({ itemId: String(item._id), mode: 'remove', qty: 50 }, admin),
            'cannot remove',
            assert
        );
        assert.equal((await FoodItem.findById(item._id)).stockQty, 5);
        assert.equal(await FoodStockMovement.countDocuments({}), 0, 'a refused adjustment writes nothing');
    });

    it('will not add to an untracked item, but Set gives it an opening balance', async () => {
        const store = await seedStore();
        const item = await makeItem(store, { stockQty: null });

        await expectError(
            () => stock.adjustStock({ itemId: String(item._id), mode: 'add', qty: 5 }, admin),
            'untracked',
            assert
        );

        await stock.adjustStock({ itemId: String(item._id), mode: 'set', qty: 40 }, admin);
        const [move] = await FoodStockMovement.find({ itemId: item._id }).lean();
        assert.equal(move.type, 'opening', 'the first Set on an untracked item is its opening stock');
        assert.equal(move.qtyBefore, null);
        assert.equal(move.qtyAfter, 40);
    });

    it('toggles availability as the shelf empties and refills', async () => {
        const store = await seedStore();
        const item = await makeItem(store, { stockQty: 2 });
        await stock.adjustStock({ itemId: String(item._id), mode: 'set', qty: 0 }, admin);
        assert.equal((await FoodItem.findById(item._id)).isAvailable, false);
        await stock.adjustStock({ itemId: String(item._id), mode: 'add', qty: 7 }, admin);
        assert.equal((await FoodItem.findById(item._id)).isAvailable, true);
    });
});

describe('stock verification', () => {
    it('runs the full lifecycle and applies only the counted lines', async () => {
        const store = await seedStore();
        const milk = await makeItem(store, { name: 'Milk', stockQty: 100 });
        const bread = await makeItem(store, { name: 'Bread', stockQty: 20 });

        const created = await stock.createVerification({ restaurantId: String(store._id) }, admin);
        assert.match(created.verificationNo, /^STV\d{7}$/);
        assert.equal(created.itemCount, 2);
        assert.equal(created.status, 'draft');

        const milkLine = created.items.find((l) => l.itemName === 'Milk');
        assert.equal(milkLine.bookQty, 100, 'book quantity is snapshotted at creation');

        const updated = await stock.updateVerification(created.id, {
            items: [{ id: milkLine.id, countedQty: 97, note: '3 broken' }]
        });
        assert.equal(updated.items.find((l) => l.itemName === 'Milk').difference, -3);
        assert.equal(updated.countedCount, 1);

        const done = await stock.completeVerification(created.id, admin);
        assert.equal(done.status, 'completed');
        assert.deepEqual(done.applied, [{ itemId: String(milk._id), difference: -3 }]);

        assert.equal((await FoodItem.findById(milk._id)).stockQty, 97, 'counted line is applied');
        assert.equal((await FoodItem.findById(bread._id)).stockQty, 20, 'uncounted line is left alone');

        const [move] = await FoodStockMovement.find({ itemId: milk._id }).lean();
        assert.equal(move.type, 'verification');
        assert.equal(move.qtyChange, -3);
        assert.equal(move.reference.label, created.verificationNo);
        assert.equal(move.note, '3 broken');
    });

    it('needs at least one counted line before it can be completed', async () => {
        const store = await seedStore();
        await makeItem(store);
        const created = await stock.createVerification({ restaurantId: String(store._id) }, admin);
        await expectError(() => stock.completeVerification(created.id, admin), 'at least one product', assert);
    });

    it('cannot be completed, edited or deleted once completed', async () => {
        const store = await seedStore();
        await makeItem(store, { stockQty: 10 });
        const created = await stock.createVerification({ restaurantId: String(store._id) }, admin);
        await stock.updateVerification(created.id, { items: [{ id: created.items[0].id, countedQty: 9 }] });
        await stock.completeVerification(created.id, admin);

        await expectError(() => stock.completeVerification(created.id, admin), 'already completed', assert);
        await expectError(
            () => stock.updateVerification(created.id, { note: 'late edit' }),
            'cannot be edited',
            assert
        );
        await expectError(() => stock.deleteVerification(created.id), 'cannot be deleted', assert);
    });

    it('refuses a store with nothing tracked to count', async () => {
        const store = await seedStore();
        await makeItem(store, { stockQty: null });
        await expectError(
            () => stock.createVerification({ restaurantId: String(store._id) }, admin),
            'No tracked products',
            assert
        );
    });

    it('allows a draft to be cancelled and then deleted', async () => {
        const store = await seedStore();
        await makeItem(store, { stockQty: 5 });
        const created = await stock.createVerification({ restaurantId: String(store._id) }, admin);
        assert.equal((await stock.cancelVerification(created.id)).status, 'cancelled');
        await stock.deleteVerification(created.id);
        const { total } = await stock.listVerifications({});
        assert.equal(total, 0);
    });
});

/**
 * The thresholds a shop configures once, on the outlet.
 *
 * These are the whole point of the feature -- nobody fills in three numbers on
 * four thousand SKUs -- so every screen that classifies stock has to read them.
 * Each of these pins a place that was reading the platform defaults instead.
 */
describe('outlet-level stock thresholds', () => {
    const strictStore = () =>
        FoodRestaurant.create({
            restaurantName: 'Strict Store',
            ownerName: 'Owner',
            ownerPhone: '9000000001',
            phone: '9000000001',
            // Far stricter than the platform defaults (10 / 3 / 0), so a row
            // classified against the defaults lands in a different tier and the
            // test cannot pass by accident.
            stockThresholds: { low: 50, critical: 25, out: 5 }
        });

    it('classifies the admin stock screen against the outlet, not the defaults', async () => {
        const store = await strictStore();
        await makeItem(store, { name: 'Fortyish', stockQty: 40 });

        const { stocks } = await stock.listStocks({ restaurantId: String(store._id), limit: 50 });
        assert.equal(
            stocks.find((s) => s.name === 'Fortyish').status,
            'low',
            '40 units is plenty by the platform default and low by this outlet’s'
        );
    });

    it('still lets a product override its outlet', async () => {
        const store = await strictStore();
        await makeItem(store, { name: 'Bulk', stockQty: 40, lowStockThreshold: 5 });

        const { stocks } = await stock.listStocks({ restaurantId: String(store._id), limit: 50 });
        assert.equal(stocks.find((s) => s.name === 'Bulk').status, 'in_stock');
    });
});
