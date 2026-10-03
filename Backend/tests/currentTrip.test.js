import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, someId } from './helpers/db.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { getCurrentTripDelivery } from '../src/modules/food/orders/services/order-delivery.service.js';

/**
 * "What is my current trip?" -- the question a rider's app asks on every launch.
 *
 * It used to pick the most recently *updated* order. That is fine for one order
 * and wrong the moment block batching can add a second one mid-trip: the new
 * order's write made it the newest, so the first one -- still being carried --
 * vanished from the rider's screen. It must stay the trip until it is done, and
 * the other order has to be reported rather than lost.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const RIDER = someId();
const MIN = 60 * 1000;
let STORE_A;
let STORE_B;

beforeEach(async () => {
    const mk = (name, phone, lng) =>
        FoodRestaurant.create({
            restaurantName: name,
            ownerName: 'Owner',
            ownerPhone: phone,
            phone,
            status: 'approved',
            location: { type: 'Point', coordinates: [lng, 17.385] }
        });
    STORE_A = await mk('Store A', '9000022222', 78.4867);
    STORE_B = await mk('Store B', '9000033333', 78.489);
});

const order = (store, assignedMinutesAgo, over = {}) =>
    FoodOrder.create({
        userId: someId(),
        restaurantId: store._id,
        items: [{ itemId: String(someId()), name: 'Milk', price: 50, quantity: 1 }],
        pricing: { subtotal: 50, total: 50, roadDistanceKm: 3.2 },
        payment: { method: 'cash' },
        deliveryAddress: {
            street: 'x',
            city: 'y',
            state: 'z',
            location: { type: 'Point', coordinates: [78.49, 17.39] }
        },
        orderStatus: 'preparing',
        dispatch: {
            status: 'accepted',
            deliveryPartnerId: RIDER,
            assignedAt: new Date(Date.now() - assignedMinutesAgo * MIN),
            acceptedAt: new Date(Date.now() - assignedMinutesAgo * MIN)
        },
        ...over
    });

describe('current trip', () => {
    it('is null for a rider with nothing', async () => {
        assert.equal(await getCurrentTripDelivery(RIDER), null);
    });

    it('is the one order a rider holds, with no batch', async () => {
        const only = await order(STORE_A, 5);
        const trip = await getCurrentTripDelivery(RIDER);

        assert.equal(String(trip._id), String(only._id));
        assert.equal(trip.batchOrders?.length ?? 0, 0, 'nothing else is on the plate');
    });

    it('stays the first order accepted when a second is added mid-trip', async () => {
        const first = await order(STORE_A, 10);
        // The second is written LATER, so it is the most recently updated -- the
        // old sort would have made it "the" trip and dropped the first.
        const second = await order(STORE_B, 1);

        const trip = await getCurrentTripDelivery(RIDER);

        assert.equal(String(trip._id), String(first._id));
        assert.equal(trip.batchOrders.length, 1);
        assert.equal(String(trip.batchOrders[0]._id), String(second._id));
    });

    it('reports the other order as a summary the banner can render', async () => {
        await order(STORE_A, 10);
        const second = await order(STORE_B, 1);

        const [summary] = (await getCurrentTripDelivery(RIDER)).batchOrders;

        assert.equal(summary.order_id, second.order_id);
        assert.equal(summary.orderStatus, 'preparing');
        assert.equal(summary.restaurantName, 'Store B');
        assert.equal(summary.pricing.total, 50);
        assert.equal(summary.items, undefined, 'a summary, not the whole order');
    });

    it('becomes the next order on its own once the first is delivered', async () => {
        const first = await order(STORE_A, 10);
        const second = await order(STORE_B, 1);

        await FoodOrder.updateOne({ _id: first._id }, { $set: { orderStatus: 'delivered' } });

        const trip = await getCurrentTripDelivery(RIDER);
        assert.equal(String(trip._id), String(second._id));
        assert.equal(trip.batchOrders.length, 0);
    });

    it('ignores another rider\'s orders and anything not yet accepted', async () => {
        await order(STORE_A, 5, { dispatch: { status: 'accepted', deliveryPartnerId: someId(), assignedAt: new Date() } });
        await order(STORE_B, 5, { dispatch: { status: 'assigned', deliveryPartnerId: RIDER, assignedAt: new Date() } });

        assert.equal(await getCurrentTripDelivery(RIDER), null);
    });

    it('counts an order the seller has not answered yet (status created)', async () => {
        const o = await order(STORE_A, 2, { orderStatus: 'created' });
        const trip = await getCurrentTripDelivery(RIDER);
        assert.equal(String(trip._id), String(o._id));
    });

    it('requires a rider id', async () => {
        await assert.rejects(() => getCurrentTripDelivery(undefined), /Delivery partner ID required/);
    });
});
