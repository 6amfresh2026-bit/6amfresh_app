import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, someId } from './helpers/db.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { dispatchDueBookings } from '../src/modules/food/orders/services/order-dispatch.service.js';

/**
 * Bookings, and when a rider is finally sought for one.
 *
 * A booking deliberately does not hunt a rider when it is placed: holding one
 * from midnight for a 7am round is worse than useless. Something has to come
 * back when the window is close, and for a long time the only thing that did
 * was a delayed BullMQ job -- which this project's own configuration disables.
 * In that deployment a booked slot was never dispatched at all.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

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

const aBooking = (over = {}) =>
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
        scheduledAt: new Date(Date.now() + 8 * HOUR),
        dispatch: { status: 'unassigned', deliveryPartnerId: null },
        ...over
    });

describe('a booking whose window is still hours away', () => {
    it('is left alone', async () => {
        await aBooking();
        assert.equal(await dispatchDueBookings({}), 0);
    });

    it('is left alone even after the seller accepts it', async () => {
        // Accepting is not a reason to send a rider out at midnight.
        await aBooking({ orderStatus: 'confirmed' });
        assert.equal(await dispatchDueBookings({}), 0);
    });
});

describe('a booking whose window has arrived', () => {
    it('is dispatched', async () => {
        await aBooking({ scheduledAt: new Date(Date.now() + 5 * MINUTE) });
        assert.equal(await dispatchDueBookings({}), 1);
    });

    it('is dispatched even when the seller accepted it yesterday', async () => {
        // The case nothing else covers. The unaccepted-order sweep only looks
        // at `created`, and a seller who accepts tomorrow's order today moves
        // it out of that hours before anybody should be riding anywhere -- so
        // with the queue disabled this booking was never dispatched by
        // anything at all.
        await aBooking({ orderStatus: 'confirmed', scheduledAt: new Date(Date.now() + 5 * MINUTE) });
        assert.equal(await dispatchDueBookings({}), 1);
    });

    it('is dispatched when its window has already passed', async () => {
        // Late is still owed a rider; cancelling it is the expiry sweep's job.
        await aBooking({ scheduledAt: new Date(Date.now() - 30 * MINUTE) });
        assert.equal(await dispatchDueBookings({}), 1);
    });
});

describe('what the booking sweep must never touch', () => {
    it('leaves an ordinary same-minute order to the ordinary path', async () => {
        await aBooking({ scheduledAt: null });
        assert.equal(await dispatchDueBookings({}), 0);
    });

    it('leaves a booking that already has a rider', async () => {
        await aBooking({
            scheduledAt: new Date(Date.now() + 5 * MINUTE),
            dispatch: { status: 'assigned', deliveryPartnerId: someId(), assignmentMode: 'manual' }
        });
        assert.equal(await dispatchDueBookings({}), 0);
    });

    it('leaves an order that was never paid for', async () => {
        await aBooking({ orderStatus: 'pending_payment', scheduledAt: new Date(Date.now() + 5 * MINUTE) });
        assert.equal(await dispatchDueBookings({}), 0);
    });

    it('leaves a booking that is already over', async () => {
        await aBooking({ orderStatus: 'cancelled_by_user', scheduledAt: new Date(Date.now() + 5 * MINUTE) });
        await aBooking({ orderStatus: 'delivered', scheduledAt: new Date(Date.now() + 5 * MINUTE) });
        assert.equal(await dispatchDueBookings({}), 0);
    });

    it('takes a batch at a time rather than a whole morning at once', async () => {
        for (let i = 0; i < 3; i += 1) {
            await aBooking({ scheduledAt: new Date(Date.now() + 5 * MINUTE) });
        }
        assert.equal(await dispatchDueBookings({}), 3);
    });
});
