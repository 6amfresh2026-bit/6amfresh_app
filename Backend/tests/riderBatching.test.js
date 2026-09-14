import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, someId } from './helpers/db.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import {
    canPartnerTakeOrder,
    getActiveDeliveriesForPartner,
    getDeliveryPartnerLoads,
    MAX_ACTIVE_ORDERS_PER_RIDER,
    BATCH_DROP_RADIUS_KM
} from '../src/modules/food/orders/services/order.helpers.js';

/**
 * Rider batching.
 *
 * One order per rider is what makes the rider the most expensive line in a
 * quick-commerce order: two customers half a street apart served by two
 * separate trips from the same store. Batching is the lever — but a "batch"
 * of two unrelated pickups across town is just one late order plus another,
 * so most of this suite is about what must NOT be batched.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const STORE = someId();
const OTHER_STORE = someId();

/** Two points roughly `km` apart on the same latitude. */
const eastOf = (lng, km) => lng + km / (111.32 * Math.cos((12.97 * Math.PI) / 180));

const at = (lng, lat = 12.97) => ({
    label: 'Home',
    street: '1 Road',
    city: 'Bengaluru',
    state: 'Karnataka',
    location: { type: 'Point', coordinates: [lng, lat] }
});

const order = (over = {}) => ({
    _id: someId(),
    restaurantId: STORE,
    deliveryAddress: at(77.59),
    deliveryState: {},
    orderStatus: 'confirmed',
    ...over
});

describe('when a second order may ride along', () => {
    it('lets an idle rider take anything', () => {
        assert.equal(canPartnerTakeOrder([], order()).allowed, true);
    });

    it('adds a second order from the same store with a nearby drop', () => {
        const v = canPartnerTakeOrder([order()], order({ deliveryAddress: at(eastOf(77.59, 0.6)) }));
        assert.equal(v.allowed, true);
        assert.equal(v.activeCount, 1);
    });

    it('never batches an order the customer paid to prioritise', () => {
        // The surcharge buys a delivery with nobody in front of it, which is
        // only true if it rides alone.
        const quick = order({ pricing: { deliveryMode: 'quick' } });
        const v = canPartnerTakeOrder([order()], quick);
        assert.equal(v.allowed, false);
        assert.match(v.reason, /priority order/i);
    });

    it('never adds anything behind a priority order already in hand', () => {
        // The other direction matters just as much: it would spend the first
        // customer's money on somebody else's doorstep.
        const quick = order({ pricing: { deliveryMode: 'quick' } });
        const v = canPartnerTakeOrder([quick], order());
        assert.equal(v.allowed, false);
        assert.match(v.reason, /carrying a priority order/i);
    });

    it('refuses a second pickup from a different store', () => {
        const v = canPartnerTakeOrder([order()], order({ restaurantId: OTHER_STORE }));
        assert.equal(v.allowed, false);
        assert.match(v.reason, /different store/i);
    });

    it('refuses once the rider has already collected', () => {
        // Adding an order now means riding back to the counter.
        const collected = order({ deliveryState: { pickedUpAt: new Date() }, orderStatus: 'picked_up' });
        const v = canPartnerTakeOrder([collected], order());
        assert.equal(v.allowed, false);
        assert.match(v.reason, /already collected/i);
    });

    it('refuses a drop too far from the one already on board', () => {
        const far = order({ deliveryAddress: at(eastOf(77.59, BATCH_DROP_RADIUS_KM + 1)) });
        const v = canPartnerTakeOrder([order()], far);
        assert.equal(v.allowed, false);
        assert.match(v.reason, /too far/i);
    });

    it('refuses past the per-rider cap', () => {
        const carrying = Array.from({ length: MAX_ACTIVE_ORDERS_PER_RIDER }, () => order());
        const v = canPartnerTakeOrder(carrying, order());
        assert.equal(v.allowed, false);
        assert.match(v.reason, /already carrying/i);
    });

    it('still batches when an address has no pin, rather than refusing every order', () => {
        // Refusing here would take a whole shop's customers out of batching
        // because their addresses were saved without coordinates.
        const noPin = order({ deliveryAddress: { street: '1 Road', city: 'Bengaluru', state: 'Karnataka' } });
        assert.equal(canPartnerTakeOrder([noPin], order()).allowed, true);
        assert.equal(canPartnerTakeOrder([order()], noPin).allowed, true);
    });

    it('says which rule was broken, because the rider can act on it', () => {
        for (const v of [
            canPartnerTakeOrder([order()], order({ restaurantId: OTHER_STORE })),
            canPartnerTakeOrder([order({ deliveryState: { pickedUpAt: new Date() } })], order()),
        ]) {
            assert.equal(v.allowed, false);
            assert.notEqual(v.reason, '');
            assert.doesNotMatch(v.reason, /already have an active delivery/i, 'the old sentence told the rider nothing');
        }
    });
});

describe('what the dispatcher sees', () => {
    const rider = someId();
    const otherRider = someId();

    const live = (over = {}) =>
        FoodOrder.create({
            userId: someId(),
            restaurantId: STORE,
            items: [{ itemId: String(someId()), name: 'Milk', price: 100, quantity: 1 }],
            deliveryAddress: at(77.59),
            pricing: { subtotal: 100, total: 100 },
            payment: { method: 'cash' },
            orderStatus: 'confirmed',
            dispatch: { status: 'accepted', deliveryPartnerId: rider },
            ...over
        });

    it('does not call a rider with one order busy', async () => {
        await live();
        const { atCapacity, loadByPartner } = await getDeliveryPartnerLoads();
        assert.equal(atCapacity.has(String(rider)), false, 'one order no longer takes a rider off the road');
        assert.equal(loadByPartner.get(String(rider)).count, 1);
    });

    it('calls them busy at the cap', async () => {
        for (let i = 0; i < MAX_ACTIVE_ORDERS_PER_RIDER; i += 1) await live();
        const { atCapacity } = await getDeliveryPartnerLoads();
        assert.equal(atCapacity.has(String(rider)), true);
    });

    it('calls a rider carrying a priority order full, whatever the count', async () => {
        await live({ pricing: { deliveryMode: 'quick', subtotal: 100, total: 100 } });
        const { atCapacity, loadByPartner } = await getDeliveryPartnerLoads();
        assert.equal(loadByPartner.get(String(rider)).count, 1, 'one order');
        assert.equal(atCapacity.has(String(rider)), true, 'and still no room — that trip is undivided');
    });

    it('calls them busy once they have ridden away with goods', async () => {
        await live({ orderStatus: 'picked_up', deliveryState: { pickedUpAt: new Date() } });
        const { atCapacity } = await getDeliveryPartnerLoads();
        assert.equal(atCapacity.has(String(rider)), true, 'a collected order means no more pickups');
    });

    it('reports which stores a rider is already serving', async () => {
        await live();
        await live({ dispatch: { status: 'accepted', deliveryPartnerId: otherRider }, restaurantId: OTHER_STORE });
        const { loadByPartner } = await getDeliveryPartnerLoads();
        assert.deepEqual([...loadByPartner.get(String(rider)).restaurantIds], [String(STORE)]);
        assert.deepEqual([...loadByPartner.get(String(otherRider)).restaurantIds], [String(OTHER_STORE)]);
    });

    it('lists what one rider is carrying', async () => {
        await live();
        await live();
        assert.equal((await getActiveDeliveriesForPartner(rider)).length, 2);
        assert.equal((await getActiveDeliveriesForPartner(otherRider)).length, 0);
    });

    it('stops counting an order once it is delivered', async () => {
        const o = await live();
        o.orderStatus = 'delivered';
        o.deliveryState = { deliveredAt: new Date() };
        await o.save();
        assert.equal((await getActiveDeliveriesForPartner(rider)).length, 0);
    });
});
