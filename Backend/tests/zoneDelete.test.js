import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, expectError } from './helpers/db.js';
import { FoodZone } from '../src/modules/food/admin/models/zone.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { deleteZone } from '../src/modules/food/admin/services/admin.service.js';

/**
 * Deleting a zone a seller still points at used to go through, leaving the
 * seller with a zoneId nobody could match: checkout then refused every address
 * for that store and it dropped out of zoned listings. Same rule as brands and
 * units -- in use means it cannot be deleted.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const makeZone = (name) =>
    FoodZone.create({
        name,
        coordinates: [
            { latitude: 17.2, longitude: 78.2 },
            { latitude: 17.2, longitude: 78.8 },
            { latitude: 17.6, longitude: 78.8 }
        ]
    });

const makeStore = (zoneId, over = {}) =>
    FoodRestaurant.create({
        restaurantName: `Zone Store ${Math.random().toString(36).slice(2, 8)}`,
        ownerName: 'Owner',
        ownerPhone: `90000${Math.floor(10000 + Math.random() * 89999)}`,
        phone: '9000000000',
        status: 'approved',
        location: { type: 'Point', coordinates: [78.4867, 17.385] },
        zoneId,
        ...over
    });

describe('deleting a zone', () => {
    it('refuses while a seller is still assigned to it', async () => {
        const zone = await makeZone('Busy Zone');
        await makeStore(zone._id);

        await expectError(() => deleteZone(String(zone._id)), 'assigned to 1 seller', assert);
        assert.ok(await FoodZone.findById(zone._id), 'the zone must still exist');
    });

    it('counts every seller in the message', async () => {
        const zone = await makeZone('Busier Zone');
        await makeStore(zone._id);
        await makeStore(zone._id);

        await expectError(() => deleteZone(String(zone._id)), '2 sellers', assert);
    });

    it('also refuses when the zone is only a pending move for a seller', async () => {
        const other = await makeZone('Current Zone');
        const target = await makeZone('Pending Zone');
        await makeStore(other._id, { pendingZoneId: target._id });

        await expectError(() => deleteZone(String(target._id)), 'assigned to 1 seller', assert);
    });

    it('deletes a zone nobody uses', async () => {
        const zone = await makeZone('Empty Zone');
        const store = await makeStore((await makeZone('Elsewhere'))._id);
        assert.ok(store);

        const result = await deleteZone(String(zone._id));
        assert.deepEqual(result, { id: String(zone._id) });
        assert.equal(await FoodZone.findById(zone._id), null);
    });

    it('deletes it once the sellers have been moved away', async () => {
        const zone = await makeZone('Emptied Zone');
        const store = await makeStore(zone._id);
        await FoodRestaurant.updateOne({ _id: store._id }, { $unset: { zoneId: 1 } });

        assert.ok(await deleteZone(String(zone._id)));
    });
});
