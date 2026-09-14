import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, someId } from './helpers/db.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import { getPromisePerformance } from '../src/modules/food/admin/services/dashboardAnalytics.service.js';
import { expireUnacceptedOrders } from '../src/modules/food/orders/services/order.service.js';
import {
    buildOrderPromise,
    resolveOrderPromise
} from '../src/modules/food/orders/helpers/promise.util.js';
import { estimateDeliveryPromiseMinutes } from '../src/modules/food/orders/services/order-pricing.service.js';
import { getStoreDispatchPressure } from '../src/modules/food/orders/services/dispatch-pressure.service.js';
import { FoodDeliveryPartner } from '../src/modules/food/delivery/models/deliveryPartner.model.js';
import { PACKING_MINUTES, PER_DROP_MINUTES, AVG_SPEED_KMPH } from '../src/modules/food/orders/services/order.helpers.js';

/**
 * The delivery promise.
 *
 * The promise is the product in quick commerce, and the point of storing it is
 * that "did we arrive in time?" must be answerable about a past order using the
 * number that order's customer was actually shown — not one recomputed from
 * today's distances and constants.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const MIN = 60 * 1000;

const makeOrder = async (over = {}) =>
    FoodOrder.create({
        userId: someId(),
        restaurantId: someId(),
        items: [{ itemId: String(someId()), name: 'Milk', price: 100, quantity: 1 }],
        deliveryAddress: {
            street: '1 Road',
            city: 'Bengaluru',
            state: 'Karnataka',
            location: { type: 'Point', coordinates: [77.59, 12.97] }
        },
        pricing: { subtotal: 100, total: 100 },
        payment: { method: 'cash' },
        orderStatus: 'created',
        ...over
    });

describe('recording what the customer was told', () => {
    it('turns a quote into a deadline', () => {
        const at = new Date('2026-09-14T10:00:00Z');
        const p = buildOrderPromise({ quotedMinutes: 12, quotedAt: at, distanceKm: 1.4 });
        assert.equal(p.quotedMinutes, 12);
        assert.equal(p.dueBy.toISOString(), new Date(at.getTime() + 12 * MIN).toISOString());
        assert.equal(p.distanceKm, 1.4);
        assert.equal(buildOrderPromise({ quotedMinutes: 12, quotedAt: at }).distanceKm, null, 'an unmeasured distance is not zero km');
        assert.equal(p.outcome, 'pending');
    });

    it('counts a booking from its window, not from when it was placed', () => {
        // Arranged at midnight for the 7 AM round: seven hours of waiting is
        // the arrangement, not lateness.
        const window = new Date('2026-09-15T07:00:00Z');
        const p = buildOrderPromise({ quotedMinutes: 20, quotedAt: window });
        assert.equal(p.dueBy.toISOString(), new Date(window.getTime() + 20 * MIN).toISOString());
    });

    it('records no promise at all when there was no usable quote', () => {
        for (const bad of [null, undefined, 0, -5, NaN, '']) {
            const p = buildOrderPromise({ quotedMinutes: bad, quotedAt: new Date() });
            assert.equal(p.outcome, 'not_applicable', `${bad} should not become a promise`);
            assert.equal(p.dueBy, null);
            assert.equal(p.quotedMinutes, null, 'a zero would read as "we promised immediately"');
        }
    });

    it('rounds a fractional quote up, never down', () => {
        assert.equal(buildOrderPromise({ quotedMinutes: 11.2, quotedAt: new Date() }).quotedMinutes, 12);
    });
});

describe('what the quote is made of', () => {
    it('still quotes packing plus the ride when nothing else is known', () => {
        // The old shape, preserved: an unmeasurable rider leg must not invent
        // a distance, it must fall back.
        const km = 2.2;
        const expected = Math.ceil(PACKING_MINUTES + (km / AVG_SPEED_KMPH) * 60);
        assert.equal(estimateDeliveryPromiseMinutes(km), expected);
        assert.equal(estimateDeliveryPromiseMinutes(km, { riderLegKm: null }), expected);
    });

    it('counts the rider getting to the store, which it used to ignore', () => {
        // Systematically optimistic exactly when it mattered: a busy evening,
        // when the nearest free rider is furthest away.
        const near = estimateDeliveryPromiseMinutes(2, { riderLegKm: 0.2 });
        const far = estimateDeliveryPromiseMinutes(2, { riderLegKm: 6 });
        assert.ok(far > near, 'a distant rider has to cost minutes');
    });

    it('overlaps packing with the approach rather than adding them', () => {
        // Both happen at once. A rider two minutes away costs nothing extra
        // while the bag is still being filled.
        const quick = estimateDeliveryPromiseMinutes(2, { riderLegKm: 0.1 });
        const none = estimateDeliveryPromiseMinutes(2);
        assert.equal(quick, none);
    });

    it('adds the doorsteps already ahead of this one', () => {
        const alone = estimateDeliveryPromiseMinutes(2, { dropsAhead: 0 });
        const behindTwo = estimateDeliveryPromiseMinutes(2, { dropsAhead: 2 });
        assert.equal(behindTwo - alone, 2 * PER_DROP_MINUTES, 'batching is not free for the customer behind');
    });

    it('still refuses to quote without a distance', () => {
        for (const bad of [null, undefined, '', -1, NaN]) {
            assert.equal(estimateDeliveryPromiseMinutes(bad, { riderLegKm: 1, dropsAhead: 3 }), null);
        }
    });
});

describe('how busy the store is', () => {
    const STORE_LNG = 77.59;
    const STORE_LAT = 12.97;
    const store = () => ({ _id: someId(), location: { type: 'Point', coordinates: [STORE_LNG, STORE_LAT] } });

    const waiting = (restaurantId, over = {}) =>
        FoodOrder.create({
            userId: someId(),
            restaurantId,
            items: [{ itemId: String(someId()), name: 'Milk', price: 100, quantity: 1 }],
            deliveryAddress: {
                street: '1 Road', city: 'Bengaluru', state: 'Karnataka',
                location: { type: 'Point', coordinates: [STORE_LNG, STORE_LAT] }
            },
            pricing: { subtotal: 100, total: 100 },
            payment: { method: 'cash' },
            orderStatus: 'confirmed',
            ...over
        });

    it('counts the doorsteps the store still owes', async () => {
        const s = store();
        await waiting(s._id);
        await waiting(s._id);
        const p = await getStoreDispatchPressure(s);
        assert.equal(p.dropsAhead, 2);
    });

    it('does not queue an unpaid cart in front of people who paid', async () => {
        const s = store();
        await waiting(s._id, { orderStatus: 'pending_payment' });
        // pending_payment is never dispatched at all.
        assert.equal((await getStoreDispatchPressure(s)).dropsAhead, 0);
    });

    it('does not count a booking for later as ahead of anybody now', async () => {
        const s = store();
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await waiting(s._id, { scheduledAt: tomorrow });
        assert.equal((await getStoreDispatchPressure(s)).dropsAhead, 0);
    });

    it('stops counting once an order is delivered or cancelled', async () => {
        const s = store();
        await waiting(s._id, { orderStatus: 'delivered', deliveryState: { deliveredAt: new Date() } });
        await waiting(s._id, { orderStatus: 'cancelled_by_user' });
        assert.equal((await getStoreDispatchPressure(s)).dropsAhead, 0);
    });

    it('caps what it will admit to, rather than quoting an hour', async () => {
        const s = store();
        for (let i = 0; i < 40; i += 1) await waiting(s._id);
        assert.ok((await getStoreDispatchPressure(s)).dropsAhead <= 5);
    });

    it('measures the nearest usable rider, and reports none as null', async () => {
        const s = store();
        assert.equal((await getStoreDispatchPressure(s)).riderLegKm, null, 'no rider means no invented distance');

        await FoodDeliveryPartner.create({
            name: 'Near', phone: '9700000011', status: 'approved',
            availabilityStatus: 'online', lastLat: STORE_LAT, lastLng: STORE_LNG + 0.01,
            lastLocationAt: new Date()
        });
        const other = store();
        const p = await getStoreDispatchPressure(other);
        assert.ok(p.riderLegKm !== null && p.riderLegKm < 2);
    });
});

describe('settling it', () => {
    const at = new Date('2026-09-14T10:00:00Z');
    const promised = () => buildOrderPromise({ quotedMinutes: 10, quotedAt: at });

    it('is on time when it lands before the deadline, and exactly on it', () => {
        assert.equal(resolveOrderPromise(promised(), { at: new Date(at.getTime() + 8 * MIN), status: 'delivered' }).outcome, 'on_time');
        assert.equal(resolveOrderPromise(promised(), { at: new Date(at.getTime() + 10 * MIN), status: 'delivered' }).outcome, 'on_time', 'the deadline itself counts as met');
    });

    it('is late one second past the deadline, and says by how much', () => {
        const r = resolveOrderPromise(promised(), { at: new Date(at.getTime() + 13 * MIN), status: 'delivered' });
        assert.equal(r.outcome, 'late');
        assert.equal(r.varianceSeconds, 180);
    });

    it('reports early as a negative variance', () => {
        const r = resolveOrderPromise(promised(), { at: new Date(at.getTime() + 6 * MIN), status: 'delivered' });
        assert.equal(r.varianceSeconds, -240);
    });

    it('never scores a cancellation as late', () => {
        // A cancellation is its own failure. Counting it as late would let the
        // on-time rate be improved by cancelling more.
        for (const status of ['cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin']) {
            const r = resolveOrderPromise(promised(), { at: new Date(at.getTime() + 99 * MIN), status });
            assert.equal(r.outcome, 'not_applicable', status);
            assert.equal(r.varianceSeconds, null);
        }
    });

    it('leaves a settled promise alone however often it is replayed', () => {
        const once = resolveOrderPromise(promised(), { at: new Date(at.getTime() + 12 * MIN), status: 'delivered' });
        const twice = resolveOrderPromise(once, { at: new Date(at.getTime() + 600 * MIN), status: 'delivered' });
        assert.deepEqual(twice, once, 'a replayed webhook must not move a settled figure');
    });

    it('has nothing to settle for an order that carried no promise', () => {
        const none = buildOrderPromise({ quotedMinutes: null });
        assert.equal(resolveOrderPromise(none, { at: new Date(), status: 'delivered' }).outcome, 'not_applicable');
    });
});

describe('the order settles its own promise on save', () => {
    it('scores on delivery without the caller having to remember', async () => {
        const placed = new Date(Date.now() - 20 * MIN);
        const order = await makeOrder({
            createdAt: placed,
            promise: buildOrderPromise({ quotedMinutes: 10, quotedAt: placed })
        });
        assert.equal(order.promise.outcome, 'pending');

        order.orderStatus = 'delivered';
        order.deliveryState = { ...(order.deliveryState?.toObject?.() || {}), deliveredAt: new Date(placed.getTime() + 25 * MIN) };
        await order.save();

        const fresh = await FoodOrder.findById(order._id).lean();
        assert.equal(fresh.promise.outcome, 'late');
        assert.equal(fresh.promise.varianceSeconds, 15 * 60);
    });

    it('does not settle while the order is still moving', async () => {
        const order = await makeOrder({ promise: buildOrderPromise({ quotedMinutes: 10, quotedAt: new Date() }) });
        order.orderStatus = 'picked_up';
        await order.save();
        assert.equal((await FoodOrder.findById(order._id).lean()).promise.outcome, 'pending');
    });

    it('marks a cancelled order not applicable', async () => {
        const order = await makeOrder({ promise: buildOrderPromise({ quotedMinutes: 10, quotedAt: new Date() }) });
        order.orderStatus = 'cancelled_by_user';
        await order.save();
        assert.equal((await FoodOrder.findById(order._id).lean()).promise.outcome, 'not_applicable');
    });
});

describe('the on-time report', () => {
    const settled = (quoted, actualMinutes, over = {}) => {
        const placed = new Date();
        const promise = buildOrderPromise({ quotedMinutes: quoted, quotedAt: placed });
        return makeOrder({
            orderStatus: 'delivered',
            payment: { method: 'cash' },
            deliveryState: { deliveredAt: new Date(placed.getTime() + actualMinutes * MIN) },
            promise: resolveOrderPromise(promise, {
                at: new Date(placed.getTime() + actualMinutes * MIN),
                status: 'delivered'
            }),
            ...over
        });
    };

    it('reports the rate over orders that actually made a promise', async () => {
        await settled(10, 8);    // on time
        await settled(10, 9);    // on time
        await settled(10, 12);   // late by 2
        await makeOrder({ orderStatus: 'delivered', promise: buildOrderPromise({ quotedMinutes: null }) }); // counter sale
        await makeOrder({ orderStatus: 'created', promise: buildOrderPromise({ quotedMinutes: 10, quotedAt: new Date() }) }); // in flight

        const r = await getPromisePerformance({});
        assert.equal(r.scored, 3, 'only orders with a kept-or-missed promise are scored');
        assert.equal(r.onTime, 2);
        assert.equal(r.late, 1);
        assert.equal(r.pending, 1, 'in flight is visible, not hidden');
        assert.equal(r.notApplicable, 1);
        assert.equal(r.onTimePercent, 66.67);
        assert.equal(r.worstLateMinutes, 2);
    });

    it('counts a delivered COD order whose cash is not yet settled', async () => {
        // The money report excludes these; arrival is a different question.
        await settled(10, 7, { payment: { method: 'cash', status: 'cod_pending' } });
        const r = await getPromisePerformance({});
        assert.equal(r.scored, 1);
        assert.equal(r.onTimePercent, 100);
    });

    it('returns a null rate rather than a fake 100% when nothing was scored', async () => {
        await makeOrder({ orderStatus: 'delivered', promise: buildOrderPromise({ quotedMinutes: null }) });
        const r = await getPromisePerformance({});
        assert.equal(r.scored, 0);
        assert.equal(r.onTimePercent, null);
        assert.equal(r.avgVarianceMinutes, null);
    });
});

describe('orders nothing else would ever close', () => {
    const HOURS = 60 * 60 * 1000;

    const stuck = (over = {}) =>
        makeOrder({
            orderStatus: 'confirmed',
            acceptanceDeadlineAt: null,
            dispatch: { status: 'unassigned', deliveryPartnerId: null, offeredTo: [] },
            createdAt: new Date(Date.now() - 6 * HOURS),
            ...over
        });

    it('closes a confirmed order that never found a rider', async () => {
        // An auto-accepting store arms no acceptance clock, so this order sat
        // confirmed for ever holding its reserved stock. recoverStuckOrders
        // only resets assignments and the stale-trip sweep only looks at
        // orders already picked up — between them it was invisible.
        const order = await stuck();
        assert.equal(await expireUnacceptedOrders(), 1);
        assert.equal((await FoodOrder.findById(order._id).lean()).orderStatus, 'cancelled_by_restaurant');
    });

    it('says why, because "not accepted" would be a lie', async () => {
        const order = await stuck();
        await expireUnacceptedOrders();
        assert.match((await FoodOrder.findById(order._id).lean()).note, /no rider could be found/i);
    });

    it('leaves a booking alone, however long it has been waiting', async () => {
        // A booking is meant to wait, and its window may be days out.
        const order = await stuck({ scheduledAt: new Date(Date.now() + 2 * HOURS) });
        assert.equal(await expireUnacceptedOrders(), 0);
        assert.equal((await FoodOrder.findById(order._id).lean()).orderStatus, 'confirmed');
    });

    it('leaves an order a rider has already accepted', async () => {
        const order = await stuck({ dispatch: { status: 'accepted', deliveryPartnerId: someId() } });
        assert.equal(await expireUnacceptedOrders(), 0);
        assert.equal((await FoodOrder.findById(order._id).lean()).orderStatus, 'confirmed');
    });

    it('leaves a recent one alone', async () => {
        const order = await stuck({ createdAt: new Date() });
        assert.equal(await expireUnacceptedOrders(), 0);
        assert.equal((await FoodOrder.findById(order._id).lean()).orderStatus, 'confirmed');
    });

    it('still closes an order whose seller never answered', async () => {
        const order = await makeOrder({
            orderStatus: 'created',
            acceptanceDeadlineAt: new Date(Date.now() - 60000),
        });
        assert.equal(await expireUnacceptedOrders(), 1);
        const fresh = await FoodOrder.findById(order._id).lean();
        assert.equal(fresh.orderStatus, 'cancelled_by_restaurant');
        assert.match(fresh.note, /not accepted by restaurant/i);
    });
});
