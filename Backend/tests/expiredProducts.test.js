import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, expectError, resetDb, someId } from './helpers/db.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import {
    hideExpiredProducts,
    reserveStockForItems,
    restoreOrderStock
} from '../src/modules/food/orders/services/inventory.service.js';

/**
 * Expired stock on a product that does not use batches.
 *
 * Batch-tracked stock is guarded at allocation, but that is the rarer case.
 * A product carrying a single expiry date had that date recorded, shown on the
 * form, and then sold straight past — the one failure in this area that a
 * refund does not undo, because the customer has already eaten it.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n) => new Date(Date.now() + n * DAY);

/** Ledger rows settle just after the caller returns; they are fire-and-forget. */
const settle = () => new Promise((r) => setTimeout(r, 250));

const product = (over = {}) =>
    FoodItem.create({ restaurantId: someId(), name: 'Amul Milk 1L', price: 50, stockQty: 5, ...over });

describe('selling a product that has expired', () => {
    it('is refused, and says so rather than blaming the stock level', async () => {
        const item = await product({ expiryDate: inDays(-1) });

        // "Out of stock" would send the customer back to wait for a restock
        // that is not coming, and hides the real problem from the shop.
        await expectError(
            () => reserveStockForItems([{ itemId: String(item._id), quantity: 1 }]),
            'past its expiry date',
            assert
        );

        const after = await FoodItem.findById(item._id).lean();
        assert.equal(after.stockQty, 5, 'a refused order must leave the shelf as it found it');
    });

    it('is refused even when nobody is counting the units', async () => {
        // stockQty null never reaches the conditional decrement at all, so an
        // untracked product was the one route by which expired stock could
        // still be sold.
        const item = await product({ stockQty: null, expiryDate: inDays(-1) });

        await expectError(
            () => reserveStockForItems([{ itemId: String(item._id), quantity: 1 }]),
            'past its expiry date',
            assert
        );
    });

    it('takes the rest of the order back with it', async () => {
        const good = await product({ name: 'Bread' });
        const stale = await product({ name: 'Curd', expiryDate: inDays(-2) });

        await expectError(
            () =>
                reserveStockForItems([
                    { itemId: String(good._id), quantity: 2 },
                    { itemId: String(stale._id), quantity: 1 }
                ]),
            'past its expiry date',
            assert
        );

        const restored = await FoodItem.findById(good._id).lean();
        assert.equal(restored.stockQty, 5, 'the line taken before the failure was put back');
    });

    it('sells normally right up to the expiry, and not after', async () => {
        const fresh = await product({ expiryDate: inDays(1) });
        const taken = await reserveStockForItems([{ itemId: String(fresh._id), quantity: 2 }]);
        assert.equal(taken.length, 1);
        assert.equal((await FoodItem.findById(fresh._id).lean()).stockQty, 3);
    });

    it('leaves a product with no expiry alone', async () => {
        // Which is every product that existed before the field was fillable.
        const plain = await product({ expiryDate: null });
        await reserveStockForItems([{ itemId: String(plain._id), quantity: 1 }]);
        assert.equal((await FoodItem.findById(plain._id).lean()).stockQty, 4);
    });
});

describe('the storefront sweep', () => {
    it('hides expired products and leaves the count for someone to count', async () => {
        const stale = await product({ expiryDate: inDays(-1) });
        const fresh = await product({ expiryDate: inDays(5) });
        const plain = await product({ expiryDate: null });

        assert.equal(await hideExpiredProducts({}), 1);

        assert.equal((await FoodItem.findById(stale._id).lean()).isAvailable, false);
        assert.equal((await FoodItem.findById(stale._id).lean()).stockQty, 5, 'units are not written off, only hidden');
        assert.equal((await FoodItem.findById(fresh._id).lean()).isAvailable, true);
        assert.equal((await FoodItem.findById(plain._id).lean()).isAvailable, true);
    });

    it('leaves batch-tracked products to the batch write-off', async () => {
        // Their units live in batches; hiding the product would strand stock
        // that the batch sweep is responsible for removing.
        const batched = await product({ expiryDate: inDays(-1), manageMultipleBatch: true });
        assert.equal(await hideExpiredProducts({}), 0);
        assert.equal((await FoodItem.findById(batched._id).lean()).isAvailable, true);
    });

    it('is idempotent, so an hourly run does not keep reporting the same product', async () => {
        await product({ expiryDate: inDays(-1) });
        assert.equal(await hideExpiredProducts({}), 1);
        assert.equal(await hideExpiredProducts({}), 0);
    });
});

describe('cancelling an order that contained an expired product', () => {
    it('does not put it back on the storefront', async () => {
        // restoreOrderStock brings an item back once units arrive, which is
        // right after a stockout and wrong here: the product would be visible
        // again until the next sweep, and refused at checkout.
        const item = await product({ stockQty: 1 });
        await reserveStockForItems([{ itemId: String(item._id), quantity: 1 }]);
        assert.equal((await FoodItem.findById(item._id).lean()).isAvailable, false, 'hidden by running out');

        await FoodItem.updateOne({ _id: item._id }, { $set: { expiryDate: inDays(-1) } });

        const order = await FoodOrder.create({
            userId: someId(),
            restaurantId: item.restaurantId,
            items: [{ itemId: item._id, name: item.name, price: 50, quantity: 1 }],
            pricing: { subtotal: 50, total: 50 },
            payment: { method: 'cash' },
            deliveryAddress: {
                street: 'x',
                city: 'y',
                state: 'z',
                location: { type: 'Point', coordinates: [77.59, 12.97] }
            },
            stockReservedAt: new Date()
        });
        await restoreOrderStock(order.toObject());

        const back = await FoodItem.findById(item._id).lean();
        assert.equal(back.stockQty, 1, 'the units did come back');
        assert.equal(back.isAvailable, false, 'but the expired product stays off the storefront');
        await settle();
    });
});
