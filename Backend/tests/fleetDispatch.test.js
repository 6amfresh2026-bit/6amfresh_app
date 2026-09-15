import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, someId } from './helpers/db.js';
import { FoodDeliveryPartner } from '../src/modules/food/delivery/models/deliveryPartner.model.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import {
    pickFleetPartnerForOrder,
    sellerHasOwnFleet,
    listAvailableFleetPartners
} from '../src/modules/food/orders/services/fleetDispatch.service.js';

/**
 * Picking a rider from the seller's own fleet.
 *
 * A seller who linked even one rider used to lose automatic dispatch
 * altogether -- the order skipped dispatch and waited for a human. Owning
 * riders made delivery slower than owning none, which is the opposite of the
 * point.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const STORE = someId();
const OTHER_STORE = someId();
// Hyderabad. A degree of latitude is ~111 km.
const STORE_DOC = {
    _id: STORE,
    location: { type: 'Point', coordinates: [78.4867, 17.385] },
    restaurantName: 'Corner Store'
};
const atKm = (km) => ({ lastLat: 17.385 + km / 111, lastLng: 78.4867 });

let phoneSeq = 9000000000;

const rider = (name, over = {}) =>
    FoodDeliveryPartner.create({
        name,
        phone: String(phoneSeq++),
        status: 'approved',
        availabilityStatus: 'online',
        restaurantId: STORE,
        lastLocationAt: new Date(),
        ...atKm(1),
        ...over
    });

const anOrder = (over = {}) => ({
    _id: someId(),
    restaurantId: STORE,
    pricing: { deliveryMode: 'basic' },
    deliveryAddress: { location: { type: 'Point', coordinates: [78.4867, 17.39] } },
    ...over
});

/** An order a rider is already carrying, in the shape the capacity rules read. */
const carrying = (partnerId, over = {}) =>
    FoodOrder.create({
        userId: someId(),
        restaurantId: STORE,
        items: [{ itemId: someId(), name: 'Milk', price: 50, quantity: 1 }],
        pricing: { subtotal: 50, total: 50 },
        payment: { method: 'cash' },
        deliveryAddress: {
            street: 'x',
            city: 'y',
            state: 'z',
            location: { type: 'Point', coordinates: [78.4867, 17.39] }
        },
        orderStatus: 'confirmed',
        dispatch: { status: 'accepted', deliveryPartnerId: partnerId },
        ...over
    });

describe('a seller with their own riders', () => {
    it('is recognised as running a fleet', async () => {
        assert.equal(await sellerHasOwnFleet(STORE), false);
        await rider('Asha');
        assert.equal(await sellerHasOwnFleet(STORE), true);
    });

    it('lists only its own riders, and only the ones online', async () => {
        await rider('Asha');
        await rider('Offline Om', { availabilityStatus: 'offline' });
        await rider('Someone Else', { restaurantId: OTHER_STORE });

        const names = (await listAvailableFleetPartners(STORE)).map((p) => p.name);
        assert.deepEqual(names, ['Asha']);
    });
});

describe('choosing which rider gets the order', () => {
    it('prefers the one carrying nothing over a nearer one who is busy', async () => {
        // "Available" means an empty hand. An order handed to somebody
        // mid-delivery arrives later than the promise printed on it.
        const busy = await rider('Busy Bala', atKm(0.2));
        const free = await rider('Free Farah', atKm(3));
        await carrying(busy._id, {
            orderStatus: 'picked_up',
            deliveryState: { pickedUpAt: new Date() }
        });

        const chosen = await pickFleetPartnerForOrder(anOrder(), STORE_DOC);
        assert.equal(String(chosen.partnerId), String(free._id));
        assert.equal(chosen.activeCount, 0);
    });

    it('does not hand a second order to a rider who has not accepted the first', async () => {
        // A fleet assignment is not an offer -- the order is theirs the moment
        // it is written. Counting only accepted orders meant a rider who had
        // not opened the app yet still read as free, so every order the shop
        // took piled onto them while everybody else sat idle.
        const first = await rider('Holding Hira');
        const idle = await rider('Idle Ila', atKm(4));
        await carrying(first._id, { dispatch: { status: 'assigned', deliveryPartnerId: first._id } });

        const chosen = await pickFleetPartnerForOrder(anOrder(), STORE_DOC);
        assert.equal(String(chosen.partnerId), String(idle._id));
    });

    it('picks the nearest when both are free', async () => {
        await rider('Far Fiona', atKm(6));
        const near = await rider('Near Nita', atKm(0.5));

        const chosen = await pickFleetPartnerForOrder(anOrder(), STORE_DOC);
        assert.equal(String(chosen.partnerId), String(near._id));
    });

    it('never picks another seller\'s rider', async () => {
        await rider('Not Ours', { restaurantId: OTHER_STORE, ...atKm(0.1) });
        assert.equal(await pickFleetPartnerForOrder(anOrder(), STORE_DOC), null);
    });

    it('never picks a rider who has gone offline', async () => {
        await rider('Clocked Off', { availabilityStatus: 'offline' });
        assert.equal(await pickFleetPartnerForOrder(anOrder(), STORE_DOC), null);
    });

    it('skips anyone de-assigned from this order', async () => {
        // That was a decision about this rider and this order; re-picking them
        // on the next tick would quietly undo it.
        const dropped = await rider('Dropped Dev');
        const other = await rider('Other Oli', atKm(4));

        const chosen = await pickFleetPartnerForOrder(anOrder(), STORE_DOC, {
            excludeIds: [String(dropped._id)]
        });
        assert.equal(String(chosen.partnerId), String(other._id));
    });

    it('ranks a rider whose phone has gone quiet below one we can see', async () => {
        // Ranking, not excluding: Android Doze stops the location upload, and
        // the alternative to a stale rider is an order nobody delivers.
        const quiet = await rider('Quiet Qasim', {
            ...atKm(0.2),
            lastLocationAt: new Date(Date.now() - 3 * 60 * 60 * 1000)
        });
        const seen = await rider('Seen Sara', atKm(5));

        const chosen = await pickFleetPartnerForOrder(anOrder(), STORE_DOC);
        assert.equal(String(chosen.partnerId), String(seen._id));

        // ...but still chosen when nobody else is there.
        await FoodDeliveryPartner.deleteOne({ _id: seen._id });
        const fallback = await pickFleetPartnerForOrder(anOrder(), STORE_DOC);
        assert.equal(String(fallback.partnerId), String(quiet._id));
    });
});

describe('when every rider is already carrying something', () => {
    it('adds to a batch that genuinely rides along', async () => {
        // Same store, not yet collected, drops close together -- the batching
        // rules. Nobody is free, so this is better than the order waiting.
        const busy = await rider('Batching Bina');
        await carrying(busy._id);

        const chosen = await pickFleetPartnerForOrder(anOrder(), STORE_DOC);
        assert.equal(String(chosen.partnerId), String(busy._id));
        assert.equal(chosen.activeCount, 1);
    });

    it('returns nobody when the batch rules refuse, rather than overloading a rider', async () => {
        // Already collected: a new order means riding back to the store, which
        // is two trips wearing one rider.
        const busy = await rider('Gone Gita');
        await carrying(busy._id, {
            orderStatus: 'picked_up',
            deliveryState: { pickedUpAt: new Date() }
        });

        assert.equal(await pickFleetPartnerForOrder(anOrder(), STORE_DOC), null);
    });

    it('refuses to batch a quick order, which bought an undivided trip', async () => {
        const busy = await rider('Bina');
        await carrying(busy._id);

        const quick = anOrder({ pricing: { deliveryMode: 'quick' } });
        assert.equal(await pickFleetPartnerForOrder(quick, STORE_DOC), null);
    });
});
