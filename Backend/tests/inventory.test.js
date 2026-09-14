import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, expectError, resetDb, someId } from './helpers/db.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import { FoodStockMovement } from '../src/modules/food/orders/models/stockMovement.model.js';
import {
    releaseReservations,
    reserveStockForItems,
    restoreOrderStock,
    totalQuantityByItem
} from '../src/modules/food/orders/services/inventory.service.js';

/**
 * Stock reservation on the order path.
 *
 * The selfcheck beside this file covers the pure arithmetic; what needs a real
 * database is the part it explicitly does not simulate — the conditional
 * decrement, the partial rollback, and the claim that stops a double restock.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const makeItem = (over = {}) =>
    FoodItem.create({ restaurantId: someId(), name: 'Milk', price: 50, stockQty: 5, ...over });

/** Ledger rows settle just after the caller returns; they are fire-and-forget. */
const settle = () => new Promise((r) => setTimeout(r, 250));

describe('totalQuantityByItem', () => {
    it('sums the same item across lines and floors a bad quantity at one', () => {
        const a = String(someId());
        const totals = totalQuantityByItem([
            { itemId: a, quantity: 2 },
            { itemId: a, quantity: 1 },
            { itemId: a, quantity: 0 }
        ]);
        assert.equal(totals.get(a), 4);
    });
});

describe('reserveStockForItems', () => {
    it('decrements a tracked item and records a sale movement', async () => {
        const item = await makeItem();
        const orderId = someId();

        const taken = await reserveStockForItems([{ itemId: String(item._id), quantity: 2 }], {
            orderId,
            orderLabel: 'ORD-1'
        });

        // A reservation also reports which batches the units came from. This
        // product is not batch-tracked, so there are none — but the field is
        // there, and the shape is what callers now hand to the restore path.
        assert.deepEqual(taken, [{ itemId: String(item._id), qty: 2, allocations: [] }]);
        assert.equal((await FoodItem.findById(item._id)).stockQty, 3);

        await settle();
        const [move] = await FoodStockMovement.find({ itemId: item._id }).lean();
        assert.equal(move.type, 'sale');
        assert.equal(move.qtyChange, -2);
        assert.equal(move.qtyBefore, 5);
        assert.equal(move.qtyAfter, 3);
        assert.equal(move.reference.label, 'ORD-1');
    });

    it('hides an item once it hits zero', async () => {
        const item = await makeItem({ stockQty: 2 });
        await reserveStockForItems([{ itemId: String(item._id), quantity: 2 }]);
        const after = await FoodItem.findById(item._id);
        assert.equal(after.stockQty, 0);
        assert.equal(after.isAvailable, false);
    });

    it('lets an untracked item through without touching stock', async () => {
        const item = await makeItem({ stockQty: null });
        const taken = await reserveStockForItems([{ itemId: String(item._id), quantity: 1000 }]);
        assert.deepEqual(taken, []);
        assert.equal((await FoodItem.findById(item._id)).stockQty, null);
    });

    it('rejects an over-large quantity and leaves the shelf untouched', async () => {
        const item = await makeItem({ stockQty: 3 });
        await expectError(
            () => reserveStockForItems([{ itemId: String(item._id), quantity: 99 }]),
            'Only 3 left',
            assert
        );
        assert.equal((await FoodItem.findById(item._id)).stockQty, 3);
    });

    it('puts back everything already taken when a later line comes up short', async () => {
        const ok = await makeItem({ name: 'Bread', stockQty: 10 });
        const short = await makeItem({ name: 'Eggs', stockQty: 1 });

        await expectError(
            () =>
                reserveStockForItems([
                    { itemId: String(ok._id), quantity: 4 },
                    { itemId: String(short._id), quantity: 5 }
                ]),
            'Only 1 left',
            assert
        );

        // The whole order failed, so neither shelf may have moved.
        assert.equal((await FoodItem.findById(ok._id)).stockQty, 10);
        assert.equal((await FoodItem.findById(short._id)).stockQty, 1);
    });

    it('does not let two concurrent reservations oversell the last units', async () => {
        const item = await makeItem({ stockQty: 3 });
        const attempt = () => reserveStockForItems([{ itemId: String(item._id), quantity: 2 }]).then(
            () => 'ok',
            () => 'rejected'
        );

        const results = await Promise.all([attempt(), attempt()]);
        assert.equal(results.filter((r) => r === 'ok').length, 1, 'exactly one reservation should win');
        assert.equal((await FoodItem.findById(item._id)).stockQty, 1);
    });
});

describe('releaseReservations', () => {
    it('restores stock, re-enables the item and logs a return', async () => {
        const item = await makeItem({ stockQty: 0, isAvailable: false });
        await releaseReservations([{ itemId: String(item._id), qty: 2 }], { orderLabel: 'ORD-9' });

        const after = await FoodItem.findById(item._id);
        assert.equal(after.stockQty, 2);
        assert.equal(after.isAvailable, true);

        await settle();
        const [move] = await FoodStockMovement.find({ itemId: item._id }).lean();
        assert.equal(move.type, 'sale_return');
        assert.equal(move.qtyChange, 2);
    });

    it('leaves an item the seller switched off by hand switched off', async () => {
        const item = await makeItem({ stockQty: 0, isAvailable: false, stockOffMode: 'manual' });
        await releaseReservations([{ itemId: String(item._id), qty: 5 }]);
        const after = await FoodItem.findById(item._id);
        assert.equal(after.stockQty, 5);
        assert.equal(after.isAvailable, false, 'a manual switch-off outranks a restock');
    });
});

describe('restoreOrderStock', () => {
    const makeOrder = (item, extra = {}) =>
        FoodOrder.create({
            userId: someId(),
            restaurantId: item.restaurantId,
            items: [{ itemId: item._id, name: item.name, price: 50, quantity: 2 }],
            pricing: { subtotal: 100, total: 100 },
            payment: { method: 'cash' },
            // Coordinates are not optional: the 2dsphere index on the address
            // rejects a Point with no position, which is the same failure
            // createOrder guards against with "re-select it on the map".
            deliveryAddress: {
                street: 'x',
                city: 'y',
                state: 'z',
                location: { type: 'Point', coordinates: [77.59, 12.97] }
            },
            stockReservedAt: new Date(),
            ...extra
        });

    it('returns the reserved units exactly once, however often it is called', async () => {
        const item = await makeItem({ stockQty: 3 });
        const order = await makeOrder(item);

        assert.equal(await restoreOrderStock(order), true);
        assert.equal(await restoreOrderStock(order), false, 'second call must be a no-op');
        assert.equal(await restoreOrderStock(await FoodOrder.findById(order._id)), false);

        assert.equal((await FoodItem.findById(item._id)).stockQty, 5, 'stock must not be invented');
    });

    it('does nothing for an order that never reserved', async () => {
        const item = await makeItem({ stockQty: 3 });
        const order = await makeOrder(item, { stockReservedAt: null });
        assert.equal(await restoreOrderStock(order), false);
        assert.equal((await FoodItem.findById(item._id)).stockQty, 3);
    });
});
