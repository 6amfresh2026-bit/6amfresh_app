import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, someId } from './helpers/db.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { dispatchOrdersSellerDidNotAccept } from '../src/modules/food/orders/services/order-dispatch.service.js';
import {
    expireUnacceptedOrders,
    cancelOrder,
    updateOrderStatusAdmin,
    updateOrderStatusRestaurant
} from '../src/modules/food/orders/services/order.service.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';

/**
 * The seller answers first, but not for ever.
 *
 * A rider sent to a shop that then declines has ridden for nothing, and one
 * standing in a shop that has not started picking is worse than one who arrives
 * a minute later -- so the order waits for Accept. The cap is what stops that
 * becoming the older failure, where a seller who had left the tablet in the
 * back room held the order until it was cancelled.
 *
 * This covers the sweep, which is the half that does not depend on BullMQ.
 * BULLMQ_ENABLED is false in this project's own configuration, so the re-queue
 * inside tryAutoAssign is a no-op here and the sweep is the only thing that
 * ever sends these orders.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const MINUTE = 60 * 1000;

// A real store, because dispatch resolves one: an order pointing at a missing
// restaurant exercises the deleted-shop path rather than the one under test.
let STORE;
beforeEach(async () => {
    STORE = await FoodRestaurant.create({
        restaurantName: 'Corner Store',
        ownerName: 'Owner',
        ownerPhone: '9000000000',
        phone: '9000000000',
        status: 'approved',
        location: { type: 'Point', coordinates: [78.4867, 17.385] }
    });
});

const anOrder = (over = {}) =>
    FoodOrder.create({
        userId: someId(),
        restaurantId: STORE._id,
        items: [{ itemId: someId(), name: 'Milk', price: 50, quantity: 1 }],
        pricing: { subtotal: 50, total: 50 },
        payment: { method: 'cash' },
        deliveryAddress: {
            street: 'x',
            city: 'y',
            state: 'z',
            location: { type: 'Point', coordinates: [78.4867, 17.39] }
        },
        orderStatus: 'created',
        dispatch: { status: 'unassigned', deliveryPartnerId: null },
        ...over
    });

/**
 * Ages an order, through the raw driver.
 *
 * Mongoose marks createdAt immutable when timestamps are on, so a $set through
 * the model is dropped in silence -- the update reports success and the date
 * does not move, which makes every assertion here pass for the wrong reason.
 */
const aged = async (order, minutes) => {
    await FoodOrder.collection.updateOne(
        { _id: order._id },
        { $set: { createdAt: new Date(Date.now() - minutes * MINUTE) } },
    );
    return order;
};

describe('an order the seller has not accepted', () => {
    it('is left alone while it is still inside the wait', async () => {
        await aged(await anOrder(), 1);
        assert.equal(await dispatchOrdersSellerDidNotAccept({}), 0);
    });

    it('is picked up once the wait has run out', async () => {
        // Three minutes by default, and this one is past it.
        await aged(await anOrder(), 4);
        assert.equal(await dispatchOrdersSellerDidNotAccept({}), 1);
    });

    it('is left alone the moment somebody accepts it', async () => {
        // Accepting dispatches directly, so the sweep must not double up.
        await aged(await anOrder({ orderStatus: 'confirmed' }), 10);
        await aged(await anOrder({ orderStatus: 'preparing' }), 10);
        assert.equal(await dispatchOrdersSellerDidNotAccept({}), 0);
    });

    it('is left alone once it already has a rider', async () => {
        // Including one a person assigned by hand during the wait, which is the
        // whole point of the manual option.
        await aged(
            await anOrder({
                dispatch: { status: 'assigned', deliveryPartnerId: someId(), assignmentMode: 'manual' }
            }),
            10,
        );
        assert.equal(await dispatchOrdersSellerDidNotAccept({}), 0);
    });

    it('never touches an order that was never paid for', async () => {
        await aged(await anOrder({ orderStatus: 'pending_payment' }), 10);
        assert.equal(await dispatchOrdersSellerDidNotAccept({}), 0);
    });

    it('never touches an order that is already over', async () => {
        await aged(await anOrder({ orderStatus: 'cancelled_by_restaurant' }), 10);
        await aged(await anOrder({ orderStatus: 'delivered' }), 10);
        assert.equal(await dispatchOrdersSellerDidNotAccept({}), 0);
    });

    it('is not a booking for later, however old the order is', async () => {
        // createOrder already refuses to hunt a rider at midnight for a 7am
        // round. Reading status and age alone walked straight past that: a
        // booking placed eight hours ahead is `created` and old within minutes,
        // so it would have held a rider for the whole wait.
        await aged(await anOrder({ scheduledAt: new Date(Date.now() + 8 * 60 * MINUTE) }), 5);
        assert.equal(await dispatchOrdersSellerDidNotAccept({}), 0);
    });

    it('is swept once a booking is nearly due', async () => {
        await aged(await anOrder({ scheduledAt: new Date(Date.now() + 2 * MINUTE) }), 5);
        assert.equal(await dispatchOrdersSellerDidNotAccept({}), 1);
    });

    it('counts the wait from when the seller saw it, not from checkout', async () => {
        // An order paid for online is created when checkout starts and only
        // reaches the seller when the payment clears. Measuring from creation
        // gave a seller no wait at all whenever the customer was slow paying.
        const slowToPay = await anOrder({
            payment: { method: 'razorpay', status: 'paid' },
            acceptanceWindowSeconds: 240,
            acceptanceDeadlineAt: new Date(Date.now() + 230 * 1000)
        });
        await aged(slowToPay, 5);

        assert.equal(
            await dispatchOrdersSellerDidNotAccept({}),
            0,
            'the seller has had ten seconds with this order, not five minutes',
        );
    });

    it('takes a batch at a time rather than the whole backlog at once', async () => {
        // A queue that built up during an outage should not become one burst of
        // geo queries and push batches.
        for (let i = 0; i < 3; i += 1) await aged(await anOrder(), 5);
        const swept = await dispatchOrdersSellerDidNotAccept({});
        assert.ok(swept <= 50, `swept ${swept}, which is above the per-run cap`);
        assert.equal(swept, 3);
    });
});

describe('an order cancelled while a rider was already holding it', () => {
    it('lets the rider go, rather than sending them to collect nothing', async () => {
        // The window is real and now guaranteed: a rider is dispatched three
        // minutes in, and the acceptance clock cancels the order at four. The
        // sweep told the customer and the shop and never told the rider, who
        // rode to a shop for an order that no longer existed.
        const riderId = someId();
        const order = await anOrder({
            acceptanceWindowSeconds: 240,
            acceptanceDeadlineAt: new Date(Date.now() - MINUTE),
            dispatch: { status: 'assigned', deliveryPartnerId: riderId, assignmentMode: 'fleet' }
        });

        const cancelled = await expireUnacceptedOrders({});
        assert.equal(cancelled, 1);

        const after = await FoodOrder.findById(order._id).lean();
        assert.equal(after.orderStatus, 'cancelled_by_restaurant');
        assert.equal(after.dispatch.deliveryPartnerId, null, 'the rider must not still be holding it');
        assert.equal(after.dispatch.status, 'cancelled');
    });
});

describe('cancelling an order a rider is already working', () => {
    it('releases the rider when the customer cancels', async () => {
        // A rider is dispatched while the order is still `created`, which is
        // exactly the status a customer may still cancel from.
        const riderId = someId();
        const userId = someId();
        const order = await anOrder({
            userId,
            dispatch: { status: 'assigned', deliveryPartnerId: riderId, assignmentMode: 'fleet' }
        });

        await cancelOrder(String(order._id), String(userId), 'changed my mind');

        const after = await FoodOrder.findById(order._id).lean();
        assert.equal(after.orderStatus, 'cancelled_by_user');
        assert.equal(after.dispatch.deliveryPartnerId, null);
        assert.equal(after.dispatch.status, 'cancelled');
    });

    it('does not put collected goods back on the shelf', async () => {
        // Cancellation outranks every other status, so an admin can cancel an
        // order a rider collected ten minutes ago. Those units are in a bag on
        // a bike; restocking them sells the same goods twice.
        const item = await FoodItem.create({
            restaurantId: STORE._id,
            name: 'Milk',
            price: 50,
            stockQty: 5
        });
        const order = await anOrder({
            items: [{ itemId: item._id, name: 'Milk', price: 50, quantity: 2 }],
            orderStatus: 'picked_up',
            stockReservedAt: new Date(),
            deliveryState: { pickedUpAt: new Date() },
            dispatch: { status: 'accepted', deliveryPartnerId: someId() }
        });

        await updateOrderStatusAdmin(String(order._id), 'cancelled_by_admin', 'test', someId());

        const after = await FoodItem.findById(item._id).lean();
        assert.equal(after.stockQty, 5, 'goods on a bike are not back on the shelf');
    });

    it('does restock an order that never left the shop', async () => {
        const item = await FoodItem.create({
            restaurantId: STORE._id,
            name: 'Bread',
            price: 40,
            stockQty: 5
        });
        const order = await anOrder({
            items: [{ itemId: item._id, name: 'Bread', price: 40, quantity: 2 }],
            orderStatus: 'confirmed',
            stockReservedAt: new Date()
        });

        await updateOrderStatusAdmin(String(order._id), 'cancelled_by_admin', 'test', someId());

        const after = await FoodItem.findById(item._id).lean();
        assert.equal(after.stockQty, 7, 'nothing left the building, so the units come back');
    });

    it('does not restock a collected order when the seller cancels either', async () => {
        // The guard was fixed in the admin path first and this one kept
        // inventing stock, which is why it now lives in restoreOrderStock
        // rather than at each call site.
        const item = await FoodItem.create({
            restaurantId: STORE._id,
            name: 'Curd',
            price: 30,
            stockQty: 5
        });
        const order = await anOrder({
            items: [{ itemId: item._id, name: 'Curd', price: 30, quantity: 2 }],
            orderStatus: 'picked_up',
            stockReservedAt: new Date(),
            deliveryState: { pickedUpAt: new Date() },
            dispatch: { status: 'accepted', deliveryPartnerId: someId() }
        });

        await updateOrderStatusRestaurant(
            String(order._id),
            String(STORE._id),
            'cancelled_by_restaurant',
            'out of stock',
        );

        const after = await FoodItem.findById(item._id).lean();
        assert.equal(after.stockQty, 5, 'the seller path invented stock too');
    });

    it('treats an admin-marked pickup as collected, with no deliveryState to read', async () => {
        // The rider app writes deliveryState.pickedUpAt; an admin moving the
        // order by hand writes only the status, and the cancellation paths
        // overwrite that status before the stock guard runs. With only those
        // two signals the guard failed open and restocked goods on a bike.
        const item = await FoodItem.create({
            restaurantId: STORE._id,
            name: 'Ghee',
            price: 90,
            stockQty: 5
        });
        const order = await anOrder({
            items: [{ itemId: item._id, name: 'Ghee', price: 90, quantity: 2 }],
            orderStatus: 'picked_up',
            stockReservedAt: new Date(),
            dispatch: { status: 'accepted', deliveryPartnerId: someId() }
        });

        await updateOrderStatusAdmin(String(order._id), 'cancelled_by_admin', 'test', someId());

        const after = await FoodItem.findById(item._id).lean();
        assert.equal(after.stockQty, 5);
    });
});
