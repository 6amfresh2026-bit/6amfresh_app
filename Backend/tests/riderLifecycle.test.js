import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, someId } from './helpers/db.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { FoodDeliveryPartner } from '../src/modules/food/delivery/models/deliveryPartner.model.js';
import {
    acceptOrderDelivery,
    confirmReachedPickupDelivery,
    confirmPickupDelivery,
    confirmReachedDropDelivery,
    verifyDropOtpDelivery,
    completeDelivery,
    getCurrentTripDelivery
} from '../src/modules/food/orders/services/order-delivery.service.js';

/**
 * One delivery, start to finish, through the same service functions the rider
 * app's endpoints call -- against a real database.
 *
 * Unit tests prove each rule on its own. This is the one that would have caught
 * a status being skipped, an OTP not being required, or a delivery completing
 * for a rider who never accepted it.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

let STORE;
let RIDER;
let OTHER_RIDER;

beforeEach(async () => {
    STORE = await FoodRestaurant.create({
        restaurantName: 'Lifecycle Store',
        ownerName: 'Owner',
        ownerPhone: '9000055555',
        phone: '9000055555',
        status: 'approved',
        location: { type: 'Point', coordinates: [78.4867, 17.385] }
    });
    const partner = (name, phone) =>
        FoodDeliveryPartner.create({
            name,
            phone,
            status: 'approved',
            availabilityStatus: 'online',
            lastLat: 17.386,
            lastLng: 78.4875,
            lastLocationAt: new Date()
        });
    RIDER = await partner('Ravi', '9800011111');
    OTHER_RIDER = await partner('Other', '9800022222');
});

const anOrder = (over = {}) =>
    FoodOrder.create({
        userId: someId(),
        restaurantId: STORE._id,
        items: [{ itemId: String(someId()), name: 'Milk', price: 100, quantity: 1 }],
        pricing: { subtotal: 100, total: 158, deliveryFee: 20, roadDistanceKm: 3.2, deliveryMode: 'basic' },
        payment: { method: 'wallet', status: 'paid' },
        deliveryAddress: {
            street: 'x',
            city: 'y',
            state: 'z',
            location: { type: 'Point', coordinates: [78.49, 17.39] }
        },
        orderStatus: 'preparing',
        dispatch: { status: 'unassigned', deliveryPartnerId: null },
        ...over
    });

const fresh = (id) => FoodOrder.findById(id).select('+deliveryOtp').lean();

describe('a delivery from offer to done', () => {
    it('walks every step in order and ends delivered', async () => {
        const order = await anOrder();

        // Accept.
        await acceptOrderDelivery(order._id, RIDER._id);
        let o = await fresh(order._id);
        assert.equal(o.dispatch.status, 'accepted');
        assert.equal(String(o.dispatch.deliveryPartnerId), String(RIDER._id));
        assert.ok(o.dispatch.acceptedAt);

        // It is now the rider's current trip.
        assert.equal(String((await getCurrentTripDelivery(RIDER._id))._id), String(order._id));

        // At the store.
        await confirmReachedPickupDelivery(order._id, RIDER._id);
        o = await fresh(order._id);
        assert.equal(o.deliveryState.currentPhase, 'at_pickup');

        // Collected.
        await confirmPickupDelivery(order._id, RIDER._id, 'https://example.com/bill.jpg');
        o = await fresh(order._id);
        assert.equal(o.orderStatus, 'picked_up');
        assert.ok(o.deliveryState.pickedUpAt);

        // At the door -- this is what puts the OTP in the customer's hands.
        await confirmReachedDropDelivery(order._id, RIDER._id);
        o = await fresh(order._id);
        assert.equal(o.deliveryState.currentPhase, 'at_drop');
        assert.match(String(o.deliveryOtp || ''), /^\d{4}$/, 'a four-digit drop OTP exists once the rider is at the door');
        assert.equal(o.deliveryVerification.dropOtp.required, true);
        assert.equal(o.deliveryVerification.dropOtp.verified, false, 'not verified until the rider types it in');

        // The customer reads the code out; the rider types it in.
        await verifyDropOtpDelivery(order._id, RIDER._id, o.deliveryOtp);

        const done = await completeDelivery(order._id, RIDER._id, {});
        o = await fresh(order._id);
        assert.equal(o.orderStatus, 'delivered');
        assert.ok(o.deliveryState.deliveredAt);
        assert.ok(done);

        // Nothing is left on the rider's plate.
        assert.equal(await getCurrentTripDelivery(RIDER._id), null);
    });

    it('will not complete without the OTP being verified first', async () => {
        const order = await anOrder();
        await acceptOrderDelivery(order._id, RIDER._id);
        await confirmReachedPickupDelivery(order._id, RIDER._id);
        await confirmPickupDelivery(order._id, RIDER._id, null);
        await confirmReachedDropDelivery(order._id, RIDER._id);

        await assert.rejects(() => completeDelivery(order._id, RIDER._id, {}), /OTP|verif/i);
        assert.notEqual((await fresh(order._id)).orderStatus, 'delivered');
    });

    it('rejects a wrong OTP and accepts the right one afterwards', async () => {
        const order = await anOrder();
        await acceptOrderDelivery(order._id, RIDER._id);
        await confirmReachedPickupDelivery(order._id, RIDER._id);
        await confirmPickupDelivery(order._id, RIDER._id, null);
        await confirmReachedDropDelivery(order._id, RIDER._id);
        const { deliveryOtp } = await fresh(order._id);
        const wrong = deliveryOtp === '0000' ? '1111' : '0000';

        await assert.rejects(() => verifyDropOtpDelivery(order._id, RIDER._id, wrong), /Invalid OTP/i);
        await verifyDropOtpDelivery(order._id, RIDER._id, deliveryOtp);
    });
});

describe('who may act on an order', () => {
    it('does not let a different rider work an order they never accepted', async () => {
        const order = await anOrder();
        await acceptOrderDelivery(order._id, RIDER._id);

        await assert.rejects(() => confirmReachedPickupDelivery(order._id, OTHER_RIDER._id));
        await assert.rejects(() => confirmPickupDelivery(order._id, OTHER_RIDER._id, null));
        await assert.rejects(() => completeDelivery(order._id, OTHER_RIDER._id, {}));
        assert.equal((await fresh(order._id)).deliveryState.currentPhase, 'en_route_to_pickup', 'nothing moved');
    });

    it('does not let two riders both take the same order', async () => {
        const order = await anOrder();
        await acceptOrderDelivery(order._id, RIDER._id);

        await assert.rejects(() => acceptOrderDelivery(order._id, OTHER_RIDER._id));
        assert.equal(String((await fresh(order._id)).dispatch.deliveryPartnerId), String(RIDER._id));
    });

    it('treats a rider accepting the same order twice as the same acceptance, not a second order', async () => {
        const order = await anOrder();
        await acceptOrderDelivery(order._id, RIDER._id);
        await acceptOrderDelivery(order._id, RIDER._id);

        const count = await FoodOrder.countDocuments({ 'dispatch.deliveryPartnerId': RIDER._id, 'dispatch.status': 'accepted' });
        assert.equal(count, 1);
    });

    it('will not accept an order that was already cancelled', async () => {
        const order = await anOrder({ orderStatus: 'cancelled_by_user' });
        await assert.rejects(() => acceptOrderDelivery(order._id, RIDER._id));
    });
});

describe('what stops an order moving the wrong way', () => {
    it('will not collect an order twice', async () => {
        const order = await anOrder();
        await acceptOrderDelivery(order._id, RIDER._id);
        await confirmPickupDelivery(order._id, RIDER._id, null);

        await assert.rejects(() => confirmPickupDelivery(order._id, RIDER._id, null), /Cannot re-mark/i);
    });

    it('will not collect an order that has been cancelled', async () => {
        const order = await anOrder();
        await acceptOrderDelivery(order._id, RIDER._id);
        await FoodOrder.updateOne({ _id: order._id }, { $set: { orderStatus: 'cancelled_by_user' } });

        await assert.rejects(() => confirmPickupDelivery(order._id, RIDER._id, null));
        assert.equal((await fresh(order._id)).orderStatus, 'cancelled_by_user');
    });

    it('keeps the OTP out of the rider view of the order', async () => {
        const order = await anOrder();
        await acceptOrderDelivery(order._id, RIDER._id);
        await confirmPickupDelivery(order._id, RIDER._id, null);

        const trip = await getCurrentTripDelivery(RIDER._id);
        assert.equal(trip.deliveryOtp, undefined, 'only the customer ever sees the code');
        assert.equal(trip.deliveryVerification?.dropOtp?.otp, undefined);
        assert.ok(!JSON.stringify(trip).includes((await fresh(order._id)).deliveryOtp), 'the code is not anywhere in the payload');
    });
});
