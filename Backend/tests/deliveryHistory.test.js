import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, someId } from './helpers/db.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { FoodDeliveryPartner } from '../src/modules/food/delivery/models/deliveryPartner.model.js';
import { listDeliveryHistory } from '../src/modules/food/admin/services/admin.service.js';

/**
 * What the admin panel can say about a completed delivery.
 *
 * The awkward half of this is the orders that did not end in a delivery. They
 * carry no deliveredAt, and this schema has no cancelledAt either, so the
 * moment a cancelled run ended has to be recovered from the status history --
 * and the whole list is sorted and paged by that moment, so it cannot be
 * patched up after the fetch.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const HOUR = 60 * 60 * 1000;

let STORE;
let RIDER;

beforeEach(async () => {
    STORE = await FoodRestaurant.create({
        restaurantName: 'Corner Store',
        ownerName: 'Owner',
        ownerPhone: '9000000000',
        phone: '9000000000',
        status: 'approved',
        location: { type: 'Point', coordinates: [78.4867, 17.385] }
    });

    RIDER = await FoodDeliveryPartner.create({
        name: 'Test Rider',
        phone: '9123456780',
        status: 'approved',
        availabilityStatus: 'online'
    });
});

const anOrder = (over = {}) =>
    FoodOrder.create({
        userId: someId(),
        restaurantId: STORE._id,
        items: [{ itemId: someId().toString(), name: 'Milk 1L', price: 50, quantity: 2 }],
        pricing: { subtotal: 100, total: 100 },
        payment: { method: 'cash' },
        customerName: 'Asha',
        customerPhone: '9800000001',
        deliveryAddress: {
            street: '12 Main',
            city: 'Hyderabad',
            state: 'TS',
            location: { type: 'Point', coordinates: [78.4867, 17.39] }
        },
        dispatch: { status: 'accepted', deliveryPartnerId: RIDER._id, assignedAt: new Date(Date.now() - 2 * HOUR) },
        ...over
    });

const delivered = (at, over = {}) =>
    anOrder({
        orderStatus: 'delivered',
        deliveryState: { pickedUpAt: new Date(at - HOUR), deliveredAt: new Date(at) },
        ...over
    });

const cancelled = (at, over = {}) =>
    anOrder({
        orderStatus: 'cancelled_by_restaurant',
        statusHistory: [
            { at: new Date(at - HOUR), byRole: 'USER', from: 'created', to: 'confirmed' },
            { at: new Date(at), byRole: 'RESTAURANT', from: 'confirmed', to: 'cancelled_by_restaurant', note: 'out of stock' }
        ],
        ...over
    });

describe('which runs count as delivery history', () => {
    it('includes delivered and cancelled runs', async () => {
        await delivered(Date.now() - HOUR);
        await cancelled(Date.now() - 2 * HOUR);

        const { deliveries } = await listDeliveryHistory({});
        assert.deepEqual(
            deliveries.map((d) => d.outcome).sort(),
            ['cancelled', 'delivered']
        );
    });

    it('leaves out an order nobody was ever sent for', async () => {
        // Cancelled before dispatch is order history, not delivery history:
        // no rider ever carried anything.
        await cancelled(Date.now() - HOUR, { dispatch: { status: 'unassigned', deliveryPartnerId: null } });

        const { deliveries, pagination } = await listDeliveryHistory({});
        assert.equal(deliveries.length, 0);
        assert.equal(pagination.total, 0);
    });

    it('leaves out a run still in progress', async () => {
        await anOrder({ orderStatus: 'picked_up', deliveryState: { pickedUpAt: new Date() } });

        const { deliveries } = await listDeliveryHistory({});
        assert.equal(deliveries.length, 0);
    });
});

describe('an order cancelled after the rider had the goods', () => {
    it('is reported as returned, not merely cancelled', async () => {
        // The case the word "returned" actually means here: stock left the
        // store on a rider and came back. There is no returned order status to
        // read, so it is derived from the pickup that did happen.
        await cancelled(Date.now() - HOUR, {
            deliveryState: { pickedUpAt: new Date(Date.now() - 2 * HOUR) }
        });

        const { deliveries } = await listDeliveryHistory({});
        assert.equal(deliveries[0].outcome, 'returned');
    });

    it('is the only thing the returned filter returns', async () => {
        await delivered(Date.now() - HOUR);
        await cancelled(Date.now() - 2 * HOUR);
        const returned = await cancelled(Date.now() - 3 * HOUR, {
            deliveryState: { pickedUpAt: new Date(Date.now() - 4 * HOUR) }
        });

        const { deliveries, pagination } = await listDeliveryHistory({ outcome: 'returned' });
        assert.equal(pagination.total, 1);
        assert.equal(deliveries[0].orderObjectId, String(returned._id));
    });
});

describe('when a cancelled run ended', () => {
    it('is read from the status history, not from updatedAt', async () => {
        // updatedAt moves whenever anything touches the order afterwards -- a
        // refund days later, a note -- and the history would then claim the
        // order was cancelled on the day it was refunded.
        const cancelledAt = new Date(Date.now() - 5 * HOUR);
        const order = await cancelled(cancelledAt.getTime());
        await FoodOrder.collection.updateOne(
            { _id: order._id },
            { $set: { updatedAt: new Date() } },
        );

        const { deliveries } = await listDeliveryHistory({});
        assert.equal(
            new Date(deliveries[0].timeline.endedAt).getTime(),
            cancelledAt.getTime(),
        );
        assert.equal(deliveries[0].cancellation.byRole, 'RESTAURANT');
        assert.equal(deliveries[0].cancellation.note, 'out of stock');
    });

    it('orders the list by when each run ended, mixing both kinds', async () => {
        const old = await delivered(Date.now() - 6 * HOUR);
        const middle = await cancelled(Date.now() - 4 * HOUR);
        const recent = await delivered(Date.now() - HOUR);

        const { deliveries } = await listDeliveryHistory({});
        assert.deepEqual(
            deliveries.map((d) => d.orderObjectId),
            [recent, middle, old].map((o) => String(o._id)),
        );
    });

    it('answers the date filter for a cancelled run too', async () => {
        const dayBefore = Date.now() - 36 * HOUR;
        await cancelled(dayBefore);
        await delivered(Date.now() - HOUR);

        const today = new Date();
        const { deliveries } = await listDeliveryHistory({
            from: today.toISOString().slice(0, 10),
        });
        assert.equal(deliveries.length, 1, 'yesterday’s cancellation is out of range');
        assert.equal(deliveries[0].outcome, 'delivered');
    });
});

describe('what a cancelled row must not claim', () => {
    it('reports nothing as delivered and no cash collected', async () => {
        await cancelled(Date.now() - HOUR);

        const { deliveries } = await listDeliveryHistory({});
        const row = deliveries[0];
        assert.equal(row.items[0].orderedQuantity, 2);
        assert.equal(row.items[0].deliveredQuantity, 0);
        assert.equal(row.payment.cashCollected, 0, 'a cancelled cash order collected nothing');
    });

    it('does not flag its lines as short-picked', async () => {
        // Nothing arrives on a cancelled order by definition; calling every
        // line short-picked would bury the lines that genuinely were.
        await cancelled(Date.now() - HOUR);

        const { deliveries } = await listDeliveryHistory({});
        assert.equal(deliveries[0].shortPickedLines, 0);
    });

    it('still counts what was ordered, so the row is not empty', async () => {
        await cancelled(Date.now() - HOUR);

        const { deliveries } = await listDeliveryHistory({});
        assert.equal(deliveries[0].itemCount, 2);
    });
});

describe('a delivered run', () => {
    it('separates what was ordered from what was actually handed over', async () => {
        await delivered(Date.now() - HOUR, {
            items: [{ itemId: someId().toString(), name: 'Milk 1L', price: 50, quantity: 2, fulfilledQuantity: 1 }]
        });

        const { deliveries } = await listDeliveryHistory({});
        const line = deliveries[0].items[0];
        assert.equal(line.orderedQuantity, 2);
        assert.equal(line.deliveredQuantity, 1);
        assert.equal(line.shortPicked, true);
        assert.equal(deliveries[0].shortPickedLines, 1);
    });

    it('treats a line that predates short-picking as fully delivered', async () => {
        await delivered(Date.now() - HOUR);

        const { deliveries } = await listDeliveryHistory({});
        assert.equal(deliveries[0].items[0].deliveredQuantity, 2);
        assert.equal(deliveries[0].items[0].shortPicked, false);
    });
});
