import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb } from './helpers/db.js';
import { FoodDeliveryPartner } from '../src/modules/food/delivery/models/deliveryPartner.model.js';
import { FoodZone } from '../src/modules/food/admin/models/zone.model.js';
import { updateDeliveryAvailability } from '../src/modules/food/delivery/services/delivery.service.js';

/**
 * The zone-based dark-store toggle, and the location ping it rides on.
 *
 * Arriving at the zone putting a rider online is only safe if it can never
 * overrule something the rider chose. That is the whole risk of the feature:
 * a rider who pressed "offline" and then walked past the shop must stay
 * offline, or the button is a lie.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

// A square around the store, big enough that the "inside" point is clearly in.
const INSIDE = { lat: 17.385, lng: 78.4867 };
const OUTSIDE = { lat: 19.076, lng: 72.8777 };

let RIDER;

beforeEach(async () => {
    await FoodZone.create({
        name: 'Hyderabad Central',
        isActive: true,
        coordinates: [
            { latitude: 17.30, longitude: 78.40 },
            { latitude: 17.30, longitude: 78.60 },
            { latitude: 17.50, longitude: 78.60 },
            { latitude: 17.50, longitude: 78.40 }
        ]
    });

    RIDER = await FoodDeliveryPartner.create({
        name: 'Test Rider',
        phone: '9123456789',
        status: 'approved',
        availabilityStatus: 'offline',
        autoOnlineInZone: true
    });
});

const ping = (payload) => updateDeliveryAvailability(String(RIDER._id), payload);
const statusNow = async () =>
    (await FoodDeliveryPartner.findById(RIDER._id).select('availabilityStatus').lean()).availabilityStatus;

describe('a location ping with the toggle on', () => {
    it('puts an offline rider online inside the zone', async () => {
        const res = await ping({ latitude: INSIDE.lat, longitude: INSIDE.lng });
        assert.equal(res.availabilityStatus, 'online');
        assert.equal(res.autoOnlined, true);
        assert.equal(await statusNow(), 'online');
    });

    it('leaves them offline outside the zone', async () => {
        const res = await ping({ latitude: OUTSIDE.lat, longitude: OUTSIDE.lng });
        assert.equal(res.availabilityStatus, 'offline');
        assert.equal(res.autoOnlined, false);
    });
});

describe('what the toggle must never override', () => {
    it('does nothing when the rider has not opted in', async () => {
        await FoodDeliveryPartner.updateOne({ _id: RIDER._id }, { $set: { autoOnlineInZone: false } });
        const res = await ping({ latitude: INSIDE.lat, longitude: INSIDE.lng });
        assert.equal(res.availabilityStatus, 'offline');
    });

    it('does not lift a pause the rider chose', async () => {
        // On a break inside the zone is still on a break. Not having moved is
        // not consent to start taking orders again.
        for (const mode of ['on_break', 'washroom', 'emergency', 'vehicle_issue', 'cannot_collect']) {
            await FoodDeliveryPartner.updateOne({ _id: RIDER._id }, { $set: { availabilityStatus: mode } });
            const res = await ping({ latitude: INSIDE.lat, longitude: INSIDE.lng });
            assert.equal(res.availabilityStatus, mode, `${mode} must survive a location ping`);
        }
    });

    it('does not undo an explicit "go offline" sent from inside the zone', async () => {
        // The case that would make the offline button unusable: press it while
        // standing at the shop and be flipped straight back on.
        await FoodDeliveryPartner.updateOne({ _id: RIDER._id }, { $set: { availabilityStatus: 'online' } });
        const res = await ping({ status: 'offline', latitude: INSIDE.lat, longitude: INSIDE.lng });
        assert.equal(res.availabilityStatus, 'offline');
        assert.equal(res.autoOnlined, false);
    });
});

describe('a location ping on its own', () => {
    it('no longer knocks an online rider off shift', async () => {
        // It used to: an absent status fell through the normaliser and came out
        // "offline", so every plain location update ended the rider's shift.
        await FoodDeliveryPartner.updateOne(
            { _id: RIDER._id },
            { $set: { availabilityStatus: 'online', autoOnlineInZone: false } },
        );
        const res = await ping({ latitude: OUTSIDE.lat, longitude: OUTSIDE.lng });
        assert.equal(res.availabilityStatus, 'online');
    });

    it('still records where the rider is', async () => {
        await ping({ latitude: INSIDE.lat, longitude: INSIDE.lng });
        const fresh = await FoodDeliveryPartner.findById(RIDER._id).select('lastLat lastLng').lean();
        assert.equal(fresh.lastLat, INSIDE.lat);
        assert.equal(fresh.lastLng, INSIDE.lng);
    });

    it('leaves a paused rider paused', async () => {
        await FoodDeliveryPartner.updateOne(
            { _id: RIDER._id },
            { $set: { availabilityStatus: 'washroom', autoOnlineInZone: false } },
        );
        await ping({ latitude: OUTSIDE.lat, longitude: OUTSIDE.lng });
        assert.equal(await statusNow(), 'washroom');
    });
});
