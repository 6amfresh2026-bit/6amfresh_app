import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, someId } from './helpers/db.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { FoodDeliveryPartner } from '../src/modules/food/delivery/models/deliveryPartner.model.js';
import { tryAutoAssign } from '../src/modules/food/orders/services/order-dispatch.service.js';

/**
 * Block batching, end to end through tryAutoAssign.
 *
 * canPartnerTakeOrder() is covered in isolation by blockBatching.test.js; this
 * file is the part nothing else tested before: that a rider already carrying
 * an order gets a new nearby order from a *different* seller handed to them
 * directly, without it ever going out to the shared pool.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

// Two points a few hundred metres apart in Hyderabad -- close enough to be
// "the same block" under the default BATCH_PICKUP_RADIUS_KM / BATCH_DROP_RADIUS_KM.
const STORE_A_LOC = { type: 'Point', coordinates: [78.4867, 17.385] };
const STORE_B_LOC = { type: 'Point', coordinates: [78.489, 17.386] };
const FAR_STORE_LOC = { type: 'Point', coordinates: [78.55, 17.42] }; // several km away

let phoneSeq = 9100000000;
const nextPhone = () => String(phoneSeq++);

const makeStore = (name, location) =>
    FoodRestaurant.create({
        restaurantName: name,
        ownerName: 'Owner',
        ownerPhone: nextPhone(),
        phone: nextPhone(),
        status: 'approved',
        location
    });

const makeRider = (over = {}) =>
    FoodDeliveryPartner.create({
        name: 'Rider',
        phone: nextPhone(),
        status: 'approved',
        availabilityStatus: 'online',
        lastLat: 17.385,
        lastLng: 78.4867,
        lastLocationAt: new Date(),
        ...over
    });

const dropNear = (storeLoc, offset = 0.002) => ({
    street: 'x',
    city: 'y',
    state: 'z',
    location: { type: 'Point', coordinates: [storeLoc.coordinates[0] + offset, storeLoc.coordinates[1] + offset] }
});

const placeOrder = (storeId, over = {}) =>
    FoodOrder.create({
        userId: someId(),
        restaurantId: storeId,
        items: [{ itemId: someId(), name: 'Milk', price: 50, quantity: 1 }],
        pricing: { subtotal: 50, total: 50 },
        payment: { method: 'cash' },
        orderStatus: 'confirmed',
        dispatch: { status: 'unassigned', deliveryPartnerId: null },
        ...over
    });

describe('block batching through tryAutoAssign', () => {
    it('hands a nearby order from a different seller directly to the rider already carrying one', async () => {
        const storeA = await makeStore('Store A', STORE_A_LOC);
        const storeB = await makeStore('Store B', STORE_B_LOC);
        const rider = await makeRider();

        await placeOrder(storeA._id, {
            deliveryAddress: dropNear(STORE_A_LOC),
            dispatch: { status: 'accepted', deliveryPartnerId: rider._id }
        });

        const orderB = await placeOrder(storeB._id, { deliveryAddress: dropNear(STORE_B_LOC) });

        const result = await tryAutoAssign(orderB._id);

        assert.equal(String(result.dispatch.deliveryPartnerId), String(rider._id));
        assert.equal(result.dispatch.status, 'accepted');
        assert.equal(result.dispatch.assignmentMode, 'auto');
        assert.equal(result.dispatch.offeredTo.length, 1, 'given directly, not broadcast to a pool of one');
        assert.equal(result.dispatch.offeredTo[0].action, 'offered');
    });

    it('falls through to the normal broadcast when nobody nearby qualifies', async () => {
        const storeA = await makeStore('Store A', STORE_A_LOC);
        const farStore = await makeStore('Far Store', FAR_STORE_LOC);
        const rider = await makeRider();

        await placeOrder(storeA._id, {
            deliveryAddress: dropNear(STORE_A_LOC),
            dispatch: { status: 'accepted', deliveryPartnerId: rider._id }
        });

        const orderFar = await placeOrder(farStore._id, { deliveryAddress: dropNear(FAR_STORE_LOC) });

        const result = await tryAutoAssign(orderFar._id);

        // No direct assignment happened -- the broadcast path ran instead,
        // which only stamps assignmentMode and leaves the order unassigned
        // until somebody accepts.
        assert.equal(result.dispatch.deliveryPartnerId, null);
        assert.equal(result.dispatch.status, 'unassigned');
    });

    it('does not batch onto a rider who has already collected', async () => {
        const storeA = await makeStore('Store A', STORE_A_LOC);
        const storeB = await makeStore('Store B', STORE_B_LOC);
        const rider = await makeRider();

        await placeOrder(storeA._id, {
            deliveryAddress: dropNear(STORE_A_LOC),
            orderStatus: 'picked_up',
            deliveryState: { pickedUpAt: new Date() },
            dispatch: { status: 'accepted', deliveryPartnerId: rider._id }
        });

        const orderB = await placeOrder(storeB._id, { deliveryAddress: dropNear(STORE_B_LOC) });
        const result = await tryAutoAssign(orderB._id);

        assert.equal(result.dispatch.deliveryPartnerId, null);
        assert.equal(result.dispatch.status, 'unassigned');
    });

    it('skips a qualifying rider who has gone offline since accepting their first order', async () => {
        const storeA = await makeStore('Store A', STORE_A_LOC);
        const storeB = await makeStore('Store B', STORE_B_LOC);
        const rider = await makeRider({ availabilityStatus: 'offline' });

        await placeOrder(storeA._id, {
            deliveryAddress: dropNear(STORE_A_LOC),
            dispatch: { status: 'accepted', deliveryPartnerId: rider._id }
        });

        const orderB = await placeOrder(storeB._id, { deliveryAddress: dropNear(STORE_B_LOC) });
        const result = await tryAutoAssign(orderB._id);

        assert.equal(result.dispatch.deliveryPartnerId, null);
        assert.equal(result.dispatch.status, 'unassigned');
    });

    it('gives only one of two simultaneous same-block orders to the shared rider, and leaves the other for normal dispatch', async () => {
        const storeA = await makeStore('Store A', STORE_A_LOC);
        const storeB = await makeStore('Store B', STORE_B_LOC);
        const storeC = await makeStore('Store C', { type: 'Point', coordinates: [78.488, 17.3855] });
        const rider = await makeRider();

        await placeOrder(storeA._id, {
            deliveryAddress: dropNear(STORE_A_LOC),
            dispatch: { status: 'accepted', deliveryPartnerId: rider._id }
        });

        const orderB = await placeOrder(storeB._id, { deliveryAddress: dropNear(STORE_B_LOC) });
        const orderC = await placeOrder(storeC._id, { deliveryAddress: dropNear(STORE_B_LOC) });

        const [resultB, resultC] = await Promise.all([
            tryAutoAssign(orderB._id),
            tryAutoAssign(orderC._id)
        ]);

        const assignedToRider = [resultB, resultC].filter(
            (r) => r && String(r.dispatch.deliveryPartnerId) === String(rider._id)
        );

        // MAX_PICKUP_STOPS_PER_TRIP defaults to 2 (store A + one more), so the
        // rider can end up with at most one of these two new orders. Whichever
        // lost the race must not be silently dropped -- it has to be back in
        // normal dispatch (unassigned, not stuck mid-lock).
        assert.ok(assignedToRider.length <= 1, 'the rider cannot end up over the pickup-stop cap');

        const fresh = await FoodOrder.find({ _id: { $in: [orderB._id, orderC._id] } }).lean();
        for (const o of fresh) {
            const withRider = String(o.dispatch?.deliveryPartnerId || '') === String(rider._id);
            if (!withRider) {
                assert.equal(o.dispatch.status, 'unassigned', `order ${o._id} must be back in normal dispatch, not stuck`);
                assert.equal(o.dispatch.deliveryPartnerId, null);
            }
        }
    });

    it('sends a single order_added_to_batch-eligible assignment without erroring when no socket server is running', async () => {
        const storeA = await makeStore('Store A', STORE_A_LOC);
        const storeB = await makeStore('Store B', STORE_B_LOC);
        const rider = await makeRider();

        await placeOrder(storeA._id, {
            deliveryAddress: dropNear(STORE_A_LOC),
            dispatch: { status: 'accepted', deliveryPartnerId: rider._id }
        });

        const orderB = await placeOrder(storeB._id, { deliveryAddress: dropNear(STORE_B_LOC) });
        await assert.doesNotReject(() => tryAutoAssign(orderB._id));
    });
});
