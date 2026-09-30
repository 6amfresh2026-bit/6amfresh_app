import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { someId } from './helpers/db.js';
import {
    canPartnerTakeOrder,
    BATCH_DROP_RADIUS_KM,
    BATCH_PICKUP_RADIUS_KM,
    MAX_PICKUP_STOPS_PER_TRIP
} from '../src/modules/food/orders/services/order.helpers.js';

/**
 * Block batching: a rider already mid-delivery for one seller picking up a
 * second order from a *different* seller nearby, rather than a fresh rider
 * being dispatched for it.
 *
 * canPartnerTakeOrder() is a pure function here — no DB, no dispatch service —
 * so these tests stamp `__restaurantLocation` directly rather than going
 * through attachRestaurantLocations(), which is exercised for real against a
 * live restaurant collection in blockDispatch.test.js.
 */

const STORE_A = someId();
const STORE_B = someId();
const STORE_C = someId();

/** Two points roughly `km` apart on the same latitude. */
const eastOf = (lng, km) => lng + km / (111.32 * Math.cos((12.97 * Math.PI) / 180));

const at = (lng, lat = 12.97) => ({
    label: 'Home',
    street: '1 Road',
    city: 'Bengaluru',
    state: 'Karnataka',
    location: { type: 'Point', coordinates: [lng, lat] }
});

const restaurantAt = (lng, lat = 12.97) => ({ type: 'Point', coordinates: [lng, lat] });

const order = (store, storeLng, over = {}) => ({
    _id: someId(),
    restaurantId: store,
    deliveryAddress: at(77.59),
    deliveryState: {},
    orderStatus: 'confirmed',
    __restaurantLocation: restaurantAt(storeLng),
    ...over
});

describe('block batching: a nearby different seller', () => {
    it('adds a second order from a different, nearby store', () => {
        const active = order(STORE_A, 77.6);
        const candidate = order(STORE_B, eastOf(77.6, 0.5), {
            deliveryAddress: at(eastOf(77.59, 0.5))
        });
        const v = canPartnerTakeOrder([active], candidate);
        assert.equal(v.allowed, true);
    });

    it('refuses a pickup further than BATCH_PICKUP_RADIUS_KM from the one already on board', () => {
        const active = order(STORE_A, 77.6);
        const far = order(STORE_B, eastOf(77.6, BATCH_PICKUP_RADIUS_KM + 1));
        const v = canPartnerTakeOrder([active], far);
        assert.equal(v.allowed, false);
        assert.match(v.reason, /different store/i);
    });

    it('still refuses a drop too far, even with a nearby pickup', () => {
        const active = order(STORE_A, 77.6);
        const nearPickupFarDrop = order(STORE_B, eastOf(77.6, 0.3), {
            deliveryAddress: at(eastOf(77.59, BATCH_DROP_RADIUS_KM + 1))
        });
        const v = canPartnerTakeOrder([active], nearPickupFarDrop);
        assert.equal(v.allowed, false);
        assert.match(v.reason, /too far/i);
    });

    it('refuses once the rider has already collected, regardless of which store', () => {
        const collected = order(STORE_A, 77.6, {
            deliveryState: { pickedUpAt: new Date() },
            orderStatus: 'picked_up'
        });
        const v = canPartnerTakeOrder([collected], order(STORE_B, eastOf(77.6, 0.2)));
        assert.equal(v.allowed, false);
        assert.match(v.reason, /already collected/i);
    });

    it('never batches a priority order across stores either', () => {
        const quick = order(STORE_A, 77.6, { pricing: { deliveryMode: 'quick' } });
        const v = canPartnerTakeOrder([order(STORE_A, 77.6)], quick);
        assert.equal(v.allowed, false);
        assert.match(v.reason, /priority order/i);
    });

    it('refuses a pickup with no stamped restaurant location, rather than letting it through', () => {
        const active = order(STORE_A, 77.6);
        const unstamped = order(STORE_B, 77.6);
        delete unstamped.__restaurantLocation;
        const v = canPartnerTakeOrder([active], unstamped);
        assert.equal(v.allowed, false);
        assert.match(v.reason, /different store/i);
    });

    it('caps the trip at MAX_PICKUP_STOPS_PER_TRIP distinct sellers', () => {
        assert.equal(MAX_PICKUP_STOPS_PER_TRIP, 2, 'this test assumes the default cap');
        const active = [order(STORE_A, 77.6), order(STORE_B, eastOf(77.6, 0.2))];
        const thirdStore = order(STORE_C, eastOf(77.6, 0.3));
        const v = canPartnerTakeOrder(active, thirdStore);
        assert.equal(v.allowed, false);
        assert.match(v.reason, /different sellers/i);
    });

    it('allows a second stop when still within the cap', () => {
        const active = [order(STORE_A, 77.6)];
        const second = order(STORE_B, eastOf(77.6, 0.2));
        const v = canPartnerTakeOrder(active, second);
        assert.equal(v.allowed, true);
    });
});

describe('block batching: same-store tier is untouched', () => {
    it('still adds a second order from the same store with a nearby drop', () => {
        const active = order(STORE_A, 77.6);
        const second = order(STORE_A, 77.6, { deliveryAddress: at(eastOf(77.59, 0.6)) });
        const v = canPartnerTakeOrder([active], second);
        assert.equal(v.allowed, true);
    });

    it('same-store batching does not care about BATCH_PICKUP_RADIUS_KM at all', () => {
        // Same store means one pickup point, so the cross-store pickup radius
        // never even gets consulted -- stamp it absurdly far and confirm that
        // has no effect when restaurantId matches.
        const active = order(STORE_A, 77.6);
        const second = { ...order(STORE_A, 77.6), __restaurantLocation: restaurantAt(eastOf(77.6, 500)) };
        const v = canPartnerTakeOrder([active], second);
        assert.equal(v.allowed, true);
    });
});
