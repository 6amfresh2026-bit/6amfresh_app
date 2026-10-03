import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, someId } from './helpers/db.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import {
    getCurrentRestaurantProfile,
    updateRestaurantAcceptingOrders
} from '../src/modules/food/restaurant/services/restaurant.service.js';

/**
 * The seller app's own profile.
 *
 * zoneId and storeType were missing from the select lists, so the seller app was
 * always told zoneId "" and storeType "grocery" (the default) whatever the store
 * really was. "Set your delivery zone" could therefore never complete.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const ZONE = someId();

const store = (over = {}) =>
    FoodRestaurant.create({
        restaurantName: 'Profile Store',
        ownerName: 'Owner',
        ownerPhone: '9000044444',
        phone: '9000044444',
        status: 'approved',
        location: { type: 'Point', coordinates: [78.4867, 17.385] },
        ...over
    });

describe('the seller profile', () => {
    it('reports the zone a store is assigned to', async () => {
        const s = await store({ zoneId: ZONE });
        const profile = await getCurrentRestaurantProfile(s._id);
        assert.equal(profile.zoneId, String(ZONE));
    });

    it('reports an empty zone for a store with none, rather than failing', async () => {
        const s = await store();
        const profile = await getCurrentRestaurantProfile(s._id);
        assert.equal(profile.zoneId, '');
    });

    it('reports the real store type, not the grocery default', async () => {
        const s = await store({ storeType: 'restaurant' });
        const profile = await getCurrentRestaurantProfile(s._id);
        assert.equal(profile.storeType, 'restaurant');
    });

    it('still defaults to grocery when none was ever set', async () => {
        const s = await store();
        const profile = await getCurrentRestaurantProfile(s._id);
        assert.equal(profile.storeType, 'grocery');
    });

    it('returns null for a store that does not exist', async () => {
        assert.equal(await getCurrentRestaurantProfile(someId()), null);
        assert.equal(await getCurrentRestaurantProfile(undefined), null);
    });
});

describe('going online and offline', () => {
    it('keeps the zone and store type in the response, so the app does not lose them', async () => {
        const s = await store({ zoneId: ZONE, storeType: 'restaurant' });

        const offline = await updateRestaurantAcceptingOrders(s._id, false);
        assert.equal(offline.isAcceptingOrders, false);
        assert.equal(offline.zoneId, String(ZONE));
        assert.equal(offline.storeType, 'restaurant');

        const online = await updateRestaurantAcceptingOrders(s._id, true);
        assert.equal(online.isAcceptingOrders, true);
        assert.equal(online.zoneId, String(ZONE));
    });
});
