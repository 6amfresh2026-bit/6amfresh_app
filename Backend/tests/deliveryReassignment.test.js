import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, someId } from './helpers/db.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { FoodDeliveryPartner } from '../src/modules/food/delivery/models/deliveryPartner.model.js';
import { adminReassignOrder, listAssignableRiders } from '../src/modules/food/admin/services/adminFleet.service.js';
import { recoverStuckOrders } from '../src/modules/food/orders/services/order.service.js';
import {
    AVAILABILITY_PAUSE_MODES,
    isDispatchable,
    normalizeAvailabilityStatus
} from '../src/constants/deliveryAvailability.js';

/**
 * Moving a live order between riders.
 *
 * The hard part is not the swap, it is that the swap has to survive: the stuck
 * order watchdog used to unassign anything that had sat in `assigned` for two
 * minutes, which quietly undid every decision a person made and left the
 * reassignment history naming a rider who no longer had the order.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const MINUTE = 60 * 1000;

let STORE;
let RIDER_A;
let RIDER_B;
const ADMIN = someId();

beforeEach(async () => {
    STORE = await FoodRestaurant.create({
        restaurantName: 'Corner Store',
        ownerName: 'Owner',
        ownerPhone: '9000000000',
        phone: '9000000000',
        status: 'approved',
        location: { type: 'Point', coordinates: [78.4867, 17.385] }
    });

    RIDER_A = await FoodDeliveryPartner.create({
        name: 'Rider A', phone: '9123456781', status: 'approved',
        availabilityStatus: 'online', lastLat: 17.385, lastLng: 78.4867
    });
    RIDER_B = await FoodDeliveryPartner.create({
        name: 'Rider B', phone: '9123456782', status: 'approved',
        availabilityStatus: 'online', lastLat: 17.395, lastLng: 78.4867
    });
});

const anOrder = (over = {}) =>
    FoodOrder.create({
        userId: someId(),
        restaurantId: STORE._id,
        items: [{ itemId: someId().toString(), name: 'Milk 1L', price: 50, quantity: 1 }],
        pricing: { subtotal: 50, total: 50 },
        payment: { method: 'cash' },
        deliveryAddress: {
            street: '12 Main', city: 'Hyderabad', state: 'TS',
            location: { type: 'Point', coordinates: [78.4867, 17.39] }
        },
        orderStatus: 'confirmed',
        dispatch: { status: 'assigned', deliveryPartnerId: RIDER_A._id, assignedAt: new Date() },
        ...over
    });

describe('reassigning an order', () => {
    it('moves it and records who, to whom and why', async () => {
        const order = await anOrder();

        const result = await adminReassignOrder(order._id, RIDER_B._id, 'Vehicle problem', ADMIN);
        assert.equal(result.from.name, 'Rider A');
        assert.equal(result.to.name, 'Rider B');

        const after = await FoodOrder.findById(order._id).lean();
        assert.equal(String(after.dispatch.deliveryPartnerId), String(RIDER_B._id));
        assert.equal(after.dispatch.assignmentMode, 'manual');
        assert.equal(after.dispatch.assignedByRole, 'ADMIN');

        const [entry] = after.dispatch.reassignments;
        assert.equal(String(entry.fromPartnerId), String(RIDER_A._id));
        assert.equal(String(entry.toPartnerId), String(RIDER_B._id));
        assert.equal(entry.reason, 'Vehicle problem');
        assert.equal(entry.byRole, 'ADMIN');
    });

    it('keeps every earlier reassignment', async () => {
        // The history is the point; a second move must not overwrite the first.
        const order = await anOrder();
        await adminReassignOrder(order._id, RIDER_B._id, 'Vehicle problem', ADMIN);
        await adminReassignOrder(order._id, RIDER_A._id, 'Rider B went on break', ADMIN);

        const after = await FoodOrder.findById(order._id).lean();
        assert.deepEqual(
            after.dispatch.reassignments.map((r) => r.reason),
            ['Vehicle problem', 'Rider B went on break']
        );
    });

    it('refuses without a reason', async () => {
        const order = await anOrder();
        await assert.rejects(
            () => adminReassignOrder(order._id, RIDER_B._id, '  ', ADMIN),
            /reason is required/i
        );
    });

    it('refuses to hand an order to the rider who already has it', async () => {
        const order = await anOrder();
        await assert.rejects(
            () => adminReassignOrder(order._id, RIDER_A._id, 'Vehicle problem', ADMIN),
            /already has this order/i
        );
    });

    it('refuses once the goods have been picked up', async () => {
        // Past pickup the bag is on the road with the first rider; giving the
        // order to somebody else does not give them the goods.
        const order = await anOrder({
            orderStatus: 'picked_up',
            deliveryState: { pickedUpAt: new Date() }
        });
        await assert.rejects(
            () => adminReassignOrder(order._id, RIDER_B._id, 'Vehicle problem', ADMIN),
            /already been picked up/i
        );
    });

    it('refuses on an order that is already over', async () => {
        const order = await anOrder({ orderStatus: 'delivered' });
        await assert.rejects(
            () => adminReassignOrder(order._id, RIDER_B._id, 'Vehicle problem', ADMIN),
            /cannot be reassigned/i
        );
    });
});

describe('the stuck-order watchdog', () => {
    const makeStale = (id) =>
        FoodOrder.collection.updateOne(
            { _id: id },
            { $set: { 'dispatch.assignedAt': new Date(Date.now() - 10 * MINUTE) } },
        );

    it('still heals an auto-assignment nobody accepted', async () => {
        // The positive control. Without this the test below proves only that
        // the watchdog did not run.
        const order = await anOrder({
            dispatch: {
                status: 'assigned',
                assignmentMode: 'auto',
                deliveryPartnerId: RIDER_A._id,
                assignedAt: new Date()
            }
        });
        await makeStale(order._id);

        await recoverStuckOrders();

        const after = await FoodOrder.findById(order._id).lean();
        assert.notEqual(
            String(after.dispatch.deliveryPartnerId || ''),
            String(RIDER_A._id),
            'an unaccepted auto-assignment should have been released'
        );
    });

    it('leaves a manual assignment alone', async () => {
        const order = await anOrder();
        await adminReassignOrder(order._id, RIDER_B._id, 'Vehicle problem', ADMIN);
        await makeStale(order._id);

        await recoverStuckOrders();

        const after = await FoodOrder.findById(order._id).lean();
        assert.equal(
            String(after.dispatch.deliveryPartnerId),
            String(RIDER_B._id),
            'a rider a person chose must not be silently swapped out'
        );
        assert.equal(after.dispatch.reassignments.length, 1);
    });
});

describe('the riders offered for a reassignment', () => {
    it('reports distance from the pickup, not from the customer', async () => {
        // Rider A is standing on the store; Rider B is about a kilometre north.
        const order = await anOrder();
        const { riders, pickupKnown } = await listAssignableRiders(order._id);
        assert.equal(pickupKnown, true);

        const byName = Object.fromEntries(riders.map((r) => [r.name, r]));
        assert.equal(byName['Rider A'].distanceKm, 0);
        assert.ok(byName['Rider B'].distanceKm > 0.9 && byName['Rider B'].distanceKm < 1.3);
    });

    it('marks the rider who already has the order', async () => {
        const order = await anOrder();
        const { riders } = await listAssignableRiders(order._id);
        assert.deepEqual(
            riders.filter((r) => r.isCurrent).map((r) => r.name),
            ['Rider A']
        );
        // ...and sorts them last, so the obvious click is never a no-op.
        assert.equal(riders[riders.length - 1].name, 'Rider A');
    });

    it('says when a rider is not taking orders', async () => {
        await FoodDeliveryPartner.updateOne(
            { _id: RIDER_B._id },
            { $set: { availabilityStatus: 'on_break' } },
        );
        const order = await anOrder();
        const { riders } = await listAssignableRiders(order._id);
        const b = riders.find((r) => r.name === 'Rider B');
        assert.equal(b.availabilityLabel, 'On break');
        assert.equal(b.isDispatchable, false);
    });

    it('reports no distance for a rider whose location is unknown', async () => {
        // 0,0 is a default, not a place in the Bay of Guinea.
        await FoodDeliveryPartner.updateOne(
            { _id: RIDER_B._id },
            { $set: { lastLat: 0, lastLng: 0 } },
        );
        const order = await anOrder();
        const { riders } = await listAssignableRiders(order._id);
        assert.equal(riders.find((r) => r.name === 'Rider B').distanceKm, null);
    });
});

describe('availability modes', () => {
    it('lets dispatch send work to nobody but an online rider', async () => {
        assert.equal(isDispatchable('online'), true);
        assert.equal(isDispatchable('offline'), false);
        for (const mode of AVAILABILITY_PAUSE_MODES) {
            assert.equal(isDispatchable(mode), false, `${mode} must not receive new orders`);
        }
    });

    it('accepts the pause modes and the legacy boolean toggle alike', async () => {
        assert.equal(normalizeAvailabilityStatus(true), 'online');
        assert.equal(normalizeAvailabilityStatus('false'), 'offline');
        assert.equal(normalizeAvailabilityStatus('on_break'), 'on_break');
        assert.equal(normalizeAvailabilityStatus('vehicle_issue'), 'vehicle_issue');
    });

    it('treats anything it does not recognise as offline', async () => {
        // Failing towards "no orders" is the safe direction: the alternative is
        // sending work to a rider whose state nobody understood.
        assert.equal(normalizeAvailabilityStatus('lunch'), 'offline');
        assert.equal(normalizeAvailabilityStatus(undefined), 'offline');
    });

    it('stores a pause mode on the partner', async () => {
        await FoodDeliveryPartner.updateOne(
            { _id: RIDER_A._id },
            { $set: { availabilityStatus: 'washroom' } },
        );
        const fresh = await FoodDeliveryPartner.findById(RIDER_A._id).lean();
        assert.equal(fresh.availabilityStatus, 'washroom');
    });
});
