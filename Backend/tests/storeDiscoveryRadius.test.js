import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb } from './helpers/db.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { listApprovedRestaurants } from '../src/modules/food/restaurant/services/restaurant.service.js';
import { haversineKm } from '../src/modules/food/shared/geo.utils.js';

/**
 * Which stores a customer is shown, given where they are standing.
 *
 * A store's delivery radius has to be applied to every listing, not only when
 * the client asks to sort or filter by distance: browsing a shop that will
 * refuse you at checkout wastes the whole basket, and the refusal arrives after
 * everything has been chosen.
 *
 * The distance is computed in the pipeline rather than taken from $geoNear,
 * which drops documents with no coordinates -- that would have hidden every
 * store still in onboarding, so the cases below that must stay listed matter as
 * much as the one that must not.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

// Hyderabad. A degree of latitude is ~111 km.
const CUSTOMER = { lat: 17.385, lng: 78.4867 };
const at = (kmNorth) => [78.4867, 17.385 + kmNorth / 111];

const store = (name, over = {}) =>
    FoodRestaurant.create({
        restaurantName: name,
        ownerName: 'Owner',
        ownerPhone: '9000000000',
        phone: '9000000000',
        status: 'approved',
        isActive: true,
        location: { type: 'Point', coordinates: at(0) },
        ...over
    });

const listed = async (query = {}) => {
    const res = await listApprovedRestaurants({ lat: CUSTOMER.lat, lng: CUSTOMER.lng, limit: 50, ...query });
    const rows = res?.restaurants || res?.data || res || [];
    return (Array.isArray(rows) ? rows : []).map((r) => r.restaurantName);
};

describe('a store with a delivery radius', () => {
    it('is hidden from a customer beyond it', async () => {
        await store('Near Shop', { location: { type: 'Point', coordinates: at(1) }, deliveryRadiusKm: 3 });
        await store('Far Shop', { location: { type: 'Point', coordinates: at(10) }, deliveryRadiusKm: 3 });

        const names = await listed();
        assert.deepEqual(names, ['Near Shop']);
    });

    it('is hidden on an ordinary listing, not only a sorted or filtered one', async () => {
        // The storefront sends neither sortBy nor radiusKm by default, and that
        // was the listing an out-of-range store still appeared in.
        await store('Far Shop', { location: { type: 'Point', coordinates: at(10) }, deliveryRadiusKm: 3 });

        assert.deepEqual(await listed(), []);
        assert.deepEqual(await listed({ sortBy: 'rating' }), []);
        assert.deepEqual(await listed({ sortBy: 'newest' }), []);
    });

    it('still shows a store that has set no radius', async () => {
        // Every store, until an admin sets a figure.
        await store('Unlimited', { location: { type: 'Point', coordinates: at(40) } });
        await store('Zeroed', { location: { type: 'Point', coordinates: at(40) }, deliveryRadiusKm: 0 });

        assert.deepEqual((await listed()).sort(), ['Unlimited', 'Zeroed']);
    });
});

describe('a store that cannot be placed', () => {
    it('stays listed when it has no coordinates at all', async () => {
        // $geoNear would have dropped it. Hiding every store still in onboarding
        // is a worse failure than showing one whose range nobody can judge.
        await FoodRestaurant.create({
            restaurantName: 'No Coords',
            ownerName: 'Owner',
            ownerPhone: '9000000000',
            phone: '9000000000',
            status: 'approved',
            isActive: true
        });

        assert.deepEqual(await listed(), ['No Coords']);
    });

    it('stays listed on the [0, 0] placeholder rather than measuring as half a world away', async () => {
        await store('Placeholder', { location: { type: 'Point', coordinates: [0, 0] }, deliveryRadiusKm: 3 });

        assert.deepEqual(await listed(), ['Placeholder']);
    });

    it('sorts after the stores that can be placed', async () => {
        await store('No Coords', { location: undefined });
        await store('Close', { location: { type: 'Point', coordinates: at(2) } });

        // Nulls sort before numbers in Mongo, so without a sort key the store
        // nobody can find would head the "nearest" list.
        assert.deepEqual(await listed({ sortBy: 'nearest' }), ['Close', 'No Coords']);
    });
});

describe('the distance it reports', () => {
    it('agrees with the figure the rest of the system charges for', async () => {
        await store('Measured', { location: { type: 'Point', coordinates: at(7) } });

        const res = await listApprovedRestaurants({ lat: CUSTOMER.lat, lng: CUSTOMER.lng, limit: 5 });
        const row = (res?.restaurants || [])[0];
        const expected = haversineKm(CUSTOMER.lat, CUSTOMER.lng, at(7)[1], at(7)[0]);

        assert.ok(
            Math.abs(row.distanceInKm - expected) < 0.05,
            `listing said ${row.distanceInKm} km, haversineKm says ${expected.toFixed(2)} km`
        );
    });

    it('still honours a radius the customer asked for', async () => {
        await store('Inside', { location: { type: 'Point', coordinates: at(1) } });
        await store('Outside', { location: { type: 'Point', coordinates: at(5) } });

        assert.deepEqual(await listed({ radiusKm: 2 }), ['Inside']);
    });
});
