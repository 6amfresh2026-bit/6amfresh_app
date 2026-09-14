import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, someId } from './helpers/db.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import { FoodStockBatch } from '../src/modules/food/orders/models/stockBatch.model.js';
import {
    receiveBatch,
    allocateFefo,
    returnAllocations,
    writeOffExpiredBatches,
    getBatchSummary,
    listExpiringBatches
} from '../src/modules/food/orders/services/stockBatch.service.js';
import { reserveStockForItems, restoreOrderStock } from '../src/modules/food/orders/services/inventory.service.js';
import { adjustOrderFulfilment } from '../src/modules/food/orders/services/order-fulfilment.service.js';

/**
 * Batches and FEFO.
 *
 * A product used to carry one expiry date for every unit ever received, which
 * stops being true the moment a second delivery arrives. Milk bought on Monday
 * and milk bought on Thursday are not interchangeable, and selling the wrong
 * one is the single failure in this system that a refund does not undo.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const STORE = someId();
const DAY = 24 * 60 * 60 * 1000;
const inDays = (n) => new Date(Date.now() + n * DAY);

const product = (over = {}) =>
    FoodItem.create({
        restaurantId: STORE,
        name: 'Amul Milk 1L',
        price: 100,
        stockQty: 0,
        gstRate: 0,
        manageMultipleBatch: true,
        ...over
    });

describe('receiving an intake', () => {
    it('puts units on the shelf and records what they are', async () => {
        const milk = await product();
        await receiveBatch({ itemId: milk._id, batchNo: 'A1', expiryDate: inDays(10), quantity: 6, purchasePrice: 40 });

        assert.equal((await FoodItem.findById(milk._id).lean()).stockQty, 6, 'the count moves with the batch');
        const batch = await FoodStockBatch.findOne({ itemId: milk._id }).lean();
        assert.equal(batch.remainingQty, 6);
        assert.equal(batch.purchasePrice, 40, 'cost moves between deliveries, so it lives on the intake');
    });

    it('refuses an intake that has already expired', async () => {
        // Data entry, not a delivery. Accepting it puts unsellable units in
        // the count.
        const milk = await product();
        await assert.rejects(
            receiveBatch({ itemId: milk._id, expiryDate: inDays(-1), quantity: 5 }),
            /already expired/i
        );
    });

    it('refuses a quantity of nothing', async () => {
        const milk = await product();
        await assert.rejects(receiveBatch({ itemId: milk._id, quantity: 0 }), /more than zero/i);
    });

    it('leaves an untracked product untracked', async () => {
        // stockQty null means nobody counts this product; writing a number
        // would silently switch it into tracked stock.
        const soap = await product({ name: 'Soap', stockQty: null });
        await receiveBatch({ itemId: soap._id, quantity: 5, expiryDate: inDays(30) });
        assert.equal((await FoodItem.findById(soap._id).lean()).stockQty, null);
    });
});

describe('picking what goes off first', () => {
    it('takes the soonest expiry, not the earliest delivery', async () => {
        // The whole point of FEFO over FIFO: a short-dated delivery can arrive
        // after a long-dated one.
        const milk = await product();
        await receiveBatch({ itemId: milk._id, batchNo: 'LONG', expiryDate: inDays(30), quantity: 5 });
        await receiveBatch({ itemId: milk._id, batchNo: 'SHORT', expiryDate: inDays(2), quantity: 5 });

        const picked = await allocateFefo(milk._id, 3);
        assert.equal(picked.length, 1);
        assert.equal(picked[0].batchNo, 'SHORT');
        assert.equal(picked[0].quantity, 3);
    });

    it('spills into the next batch when one is not enough', async () => {
        const milk = await product();
        await receiveBatch({ itemId: milk._id, batchNo: 'SHORT', expiryDate: inDays(2), quantity: 2 });
        await receiveBatch({ itemId: milk._id, batchNo: 'LONG', expiryDate: inDays(30), quantity: 5 });

        const picked = await allocateFefo(milk._id, 4);
        assert.deepEqual(picked.map((p) => [p.batchNo, p.quantity]), [['SHORT', 2], ['LONG', 2]]);
    });

    it('prefers a dated batch over one that never expires', async () => {
        const milk = await product();
        await receiveBatch({ itemId: milk._id, batchNo: 'FOREVER', expiryDate: null, quantity: 5 });
        await receiveBatch({ itemId: milk._id, batchNo: 'DATED', expiryDate: inDays(9), quantity: 5 });

        assert.equal((await allocateFefo(milk._id, 1))[0].batchNo, 'DATED');
    });

    it('breaks a tie on which arrived first', async () => {
        const milk = await product();
        const sameDay = inDays(5);
        await receiveBatch({ itemId: milk._id, batchNo: 'FIRST', expiryDate: sameDay, quantity: 2, receivedAt: inDays(-3) });
        await receiveBatch({ itemId: milk._id, batchNo: 'SECOND', expiryDate: sameDay, quantity: 2, receivedAt: inDays(-1) });

        assert.equal((await allocateFefo(milk._id, 1))[0].batchNo, 'FIRST');
    });

    it('takes what it can and says so, rather than refusing a paid order', async () => {
        // The sale is already settled by the time this runs. Throwing here
        // would leave a paid order with no stock behind it.
        const milk = await product();
        await receiveBatch({ itemId: milk._id, expiryDate: inDays(5), quantity: 2 });
        const picked = await allocateFefo(milk._id, 5);
        assert.equal(picked.reduce((s, p) => s + p.quantity, 0), 2);
    });

    it('never lets two picks take the same last unit', async () => {
        const milk = await product();
        await receiveBatch({ itemId: milk._id, expiryDate: inDays(5), quantity: 3 });
        const [a, b] = await Promise.all([allocateFefo(milk._id, 3), allocateFefo(milk._id, 3)]);
        const total = [...a, ...b].reduce((s, p) => s + p.quantity, 0);
        assert.equal(total, 3, 'three units existed, three were handed out');
    });
});

describe('putting units back', () => {
    it('returns them to the batch they left', async () => {
        const milk = await product();
        await receiveBatch({ itemId: milk._id, batchNo: 'SHORT', expiryDate: inDays(2), quantity: 5 });
        await receiveBatch({ itemId: milk._id, batchNo: 'LONG', expiryDate: inDays(30), quantity: 5 });

        const picked = await allocateFefo(milk._id, 3);
        await returnAllocations(picked);

        const short = await FoodStockBatch.findOne({ batchNo: 'SHORT' }).lean();
        const long = await FoodStockBatch.findOne({ batchNo: 'LONG' }).lean();
        assert.equal(short.remainingQty, 5, 'back where they came from');
        assert.equal(long.remainingQty, 5, 'and not onto a longer-dated one');
    });
});

describe('expired stock never reaches a customer', () => {
    it('is not picked, even before the write-off sweep has run', async () => {
        // The sweep is bookkeeping, not the guard. A batch that expired an hour
        // ago is still status:'active' until something touches it — and because
        // this picks soonest-expiry first, an expired batch is the FIRST thing
        // it would choose. Measured before the fix: a customer ordering three
        // units was handed three expired ones.
        const milk = await product();
        await receiveBatch({ itemId: milk._id, batchNo: 'FRESH', expiryDate: inDays(30), quantity: 5 });
        await receiveBatch({ itemId: milk._id, batchNo: 'GONE', expiryDate: inDays(1), quantity: 5 });
        await FoodStockBatch.updateOne({ batchNo: 'GONE' }, { $set: { expiryDate: inDays(-1) } });

        const picked = await allocateFefo(milk._id, 3);
        assert.deepEqual(picked.map((p) => p.batchNo), ['FRESH'], 'not the expired one, however soon it expires');
    });

    it('is not counted as stock a shop can sell', async () => {
        const milk = await product();
        await receiveBatch({ itemId: milk._id, batchNo: 'FRESH', expiryDate: inDays(30), quantity: 2 });
        await receiveBatch({ itemId: milk._id, batchNo: 'GONE', expiryDate: inDays(1), quantity: 5 });
        await FoodStockBatch.updateOne({ batchNo: 'GONE' }, { $set: { expiryDate: inDays(-1) } });

        const summary = await getBatchSummary(milk._id);
        assert.equal(summary.totalRemaining, 2, 'stock that cannot be sold is not stock on hand');
    });

    it('comes up short rather than substituting an expired unit', async () => {
        // Nothing sellable is left, so the allocation is empty and the
        // mismatch is logged. Handing over expired goods to make the numbers
        // agree would be the worse answer.
        const milk = await product();
        await receiveBatch({ itemId: milk._id, batchNo: 'GONE', expiryDate: inDays(1), quantity: 5 });
        await FoodStockBatch.updateOne({ batchNo: 'GONE' }, { $set: { expiryDate: inDays(-1) } });
        assert.deepEqual(await allocateFefo(milk._id, 2), []);
    });
});

describe('stock that has gone off', () => {
    it('is taken off the shelf and out of the count', async () => {
        const milk = await product();
        await receiveBatch({ itemId: milk._id, batchNo: 'OLD', expiryDate: inDays(1), quantity: 4 });
        await receiveBatch({ itemId: milk._id, batchNo: 'NEW', expiryDate: inDays(20), quantity: 6 });
        assert.equal((await FoodItem.findById(milk._id).lean()).stockQty, 10);

        // Two days on, the first batch is past its date.
        const written = await writeOffExpiredBatches({ now: inDays(2) });
        assert.equal(written, 1);
        assert.equal((await FoodItem.findById(milk._id).lean()).stockQty, 6, 'expired units cannot be sold');
        assert.equal((await FoodStockBatch.findOne({ batchNo: 'OLD' }).lean()).remainingQty, 0);
    });

    it('cannot be written off twice', async () => {
        const milk = await product();
        await receiveBatch({ itemId: milk._id, expiryDate: inDays(1), quantity: 4 });
        await writeOffExpiredBatches({ now: inDays(2) });
        assert.equal(await writeOffExpiredBatches({ now: inDays(3) }), 0, 'a second sweep must not take the units again');
        assert.equal((await FoodItem.findById(milk._id).lean()).stockQty, 0);
    });

    it('is never picked once written off', async () => {
        const milk = await product();
        await receiveBatch({ itemId: milk._id, batchNo: 'OLD', expiryDate: inDays(1), quantity: 4 });
        await receiveBatch({ itemId: milk._id, batchNo: 'NEW', expiryDate: inDays(20), quantity: 6 });
        await writeOffExpiredBatches({ now: inDays(2) });

        const picked = await allocateFefo(milk._id, 3);
        assert.deepEqual(picked.map((p) => p.batchNo), ['NEW']);
    });
});

describe('an order, end to end', () => {
    it('holds named batches and gives them back on cancellation', async () => {
        const milk = await product();
        await receiveBatch({ itemId: milk._id, batchNo: 'SHORT', expiryDate: inDays(2), quantity: 2 });
        await receiveBatch({ itemId: milk._id, batchNo: 'LONG', expiryDate: inDays(30), quantity: 8 });

        const items = [{ itemId: String(milk._id), quantity: 3 }];
        const reservation = await reserveStockForItems(items, {});
        assert.equal((await FoodItem.findById(milk._id).lean()).stockQty, 7);
        assert.deepEqual(
            reservation[0].allocations.map((a) => [a.batchNo, a.quantity]),
            [['SHORT', 2], ['LONG', 1]],
            'the short-dated stock went first',
        );

        const order = await FoodOrder.create({
            userId: someId(),
            restaurantId: STORE,
            items: [{
                itemId: String(milk._id), name: 'Amul Milk 1L', price: 100, quantity: 3,
                batchAllocations: reservation[0].allocations,
            }],
            deliveryAddress: {
                street: '1 Road', city: 'Bengaluru', state: 'Karnataka',
                location: { type: 'Point', coordinates: [77.59, 12.97] }
            },
            pricing: { subtotal: 300, total: 300 },
            payment: { method: 'cash' },
            orderStatus: 'confirmed',
            stockReservedAt: new Date(),
        });

        await restoreOrderStock(order);
        await new Promise((r) => setTimeout(r, 200));

        assert.equal((await FoodItem.findById(milk._id).lean()).stockQty, 10, 'the count is whole again');
        assert.equal((await FoodStockBatch.findOne({ batchNo: 'SHORT' }).lean()).remainingQty, 2, 'and so is the short-dated batch');
        assert.equal((await FoodStockBatch.findOne({ batchNo: 'LONG' }).lean()).remainingQty, 8);
    });
});

describe('what a shop can act on', () => {
    it('says what is close to going off', async () => {
        const milk = await product();
        await receiveBatch({ itemId: milk._id, batchNo: 'SOON', expiryDate: inDays(3), quantity: 4 });
        await receiveBatch({ itemId: milk._id, batchNo: 'LATER', expiryDate: inDays(40), quantity: 6 });

        const summary = await getBatchSummary(milk._id, { expiringWithinDays: 7 });
        assert.equal(summary.totalRemaining, 10);
        assert.equal(summary.expiringSoon, 4, 'the difference between discounting it and binning it');
        assert.equal(summary.batches[0].batchNo, 'SOON', 'soonest first');
        assert.equal(summary.batches[0].daysToExpiry, 3);
    });

    it('lists it across the shop, soonest first', async () => {
        const milk = await product();
        const bread = await product({ name: 'Bread' });
        await receiveBatch({ itemId: bread._id, batchNo: 'B', expiryDate: inDays(1), quantity: 2 });
        await receiveBatch({ itemId: milk._id, batchNo: 'M', expiryDate: inDays(5), quantity: 2 });
        await receiveBatch({ itemId: milk._id, batchNo: 'FAR', expiryDate: inDays(60), quantity: 2 });

        const res = await listExpiringBatches({ restaurantId: STORE, withinDays: 7 });
        assert.deepEqual(res.batches.map((b) => b.batchNo), ['B', 'M'], 'and nothing that is fine');
        assert.equal(res.batches[0].name, 'Bread');
    });
});

describe('a substitution keeps the batches and the count together', () => {
    const makeOrder = (milk, allocations) =>
        FoodOrder.create({
            userId: someId(),
            restaurantId: STORE,
            items: [{ itemId: String(milk._id), name: 'Amul Milk 1L', price: 100, quantity: 2, batchAllocations: allocations }],
            deliveryAddress: {
                street: '1 Road', city: 'Bengaluru', state: 'Karnataka',
                location: { type: 'Point', coordinates: [77.59, 12.97] }
            },
            pricing: { subtotal: 200, total: 200 },
            payment: { method: 'cash' },
            orderStatus: 'confirmed',
            stockReservedAt: new Date(),
            substitutionPreference: 'allow'
        });

    it('gives the replacement back to its own batch when the order is cancelled', async () => {
        // The swap takes units from the replacement's batch. Returning only the
        // count would leave those units gone from the batch and present in
        // stockQty, and the gap widens with every substitution until FEFO can
        // no longer allocate stock the count insists exists.
        const lacto = await product({ name: 'Lactose Free Milk' });
        const milk = await product();
        await FoodItem.updateOne({ _id: milk._id }, { $set: { substituteItemIds: [lacto._id] } });
        await receiveBatch({ itemId: milk._id, batchNo: 'M1', expiryDate: inDays(5), quantity: 5 });
        await receiveBatch({ itemId: lacto._id, batchNo: 'L1', expiryDate: inDays(5), quantity: 5 });

        const reservation = await reserveStockForItems([{ itemId: String(milk._id), quantity: 2 }], {});
        const order = await makeOrder(milk, reservation[0].allocations);

        await adjustOrderFulfilment(order._id, {
            lines: [{ itemId: String(milk._id), substituteItemId: String(lacto._id), quantity: 2 }]
        });
        await new Promise((r) => setTimeout(r, 300));
        await restoreOrderStock(await FoodOrder.findById(order._id));
        await new Promise((r) => setTimeout(r, 300));

        const count = (await FoodItem.findById(lacto._id).lean()).stockQty;
        const batch = (await FoodStockBatch.findOne({ batchNo: 'L1' }).lean()).remainingQty;
        assert.equal(count, 5, 'the replacement count is whole again');
        assert.equal(batch, 5, 'and so is its batch');
        assert.equal(count - batch, 0, 'no drift between the two');
    });

    it('gives it back when the substitution is abandoned part way', async () => {
        const lacto = await product({ name: 'Lactose Free Milk' });
        const milk = await product();
        await FoodItem.updateOne({ _id: milk._id }, { $set: { substituteItemIds: [lacto._id] } });
        await receiveBatch({ itemId: milk._id, batchNo: 'M1', expiryDate: inDays(5), quantity: 5 });
        await receiveBatch({ itemId: lacto._id, batchNo: 'L1', expiryDate: inDays(5), quantity: 5 });

        const reservation = await reserveStockForItems([{ itemId: String(milk._id), quantity: 2 }], {});
        const order = await makeOrder(milk, reservation[0].allocations);

        // Swaps the only line, then empties it — nothing left to deliver, so
        // the whole adjustment is refused after the replacement was claimed.
        await assert.rejects(adjustOrderFulfilment(order._id, {
            lines: [
                { itemId: String(milk._id), substituteItemId: String(lacto._id), quantity: 2 },
                { itemId: String(lacto._id), fulfilledQuantity: 0 }
            ]
        }));
        await new Promise((r) => setTimeout(r, 300));

        const count = (await FoodItem.findById(lacto._id).lean()).stockQty;
        const batch = (await FoodStockBatch.findOne({ batchNo: 'L1' }).lean()).remainingQty;
        assert.equal(count, 5);
        assert.equal(batch, 5, 'claimed and released, on both sides');
    });
});
