import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, someId } from './helpers/db.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { createInitialTransaction } from '../src/modules/food/orders/services/foodTransaction.service.js';
import { getCurrentTripDelivery } from '../src/modules/food/orders/services/order-delivery.service.js';

/**
 * What a rider's app is told about an order's pricing.
 *
 * The order's transaction holds a snapshot of the money lines only. Swapping it
 * in for the order's own pricing dropped the road distance and delivery mode, so
 * the offer card had no road km to show and fell back to straight-line -- 9.6 km
 * on the rider's screen for an order the customer was quoted 13.1 km.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

describe('pricing on a rider-facing order', () => {
    it('keeps the road distance and delivery mode when a transaction exists', async () => {
        const rider = someId();
        const store = await FoodRestaurant.create({
            restaurantName: 'Pricing Store',
            ownerName: 'Owner',
            ownerPhone: '9000011111',
            phone: '9000011111',
            status: 'approved',
            location: { type: 'Point', coordinates: [78.4867, 17.385] }
        });
        const order = await FoodOrder.create({
            userId: someId(),
            restaurantId: store._id,
            items: [{ itemId: String(someId()), name: 'Milk', price: 100, quantity: 1 }],
            pricing: {
                subtotal: 100,
                total: 158,
                deliveryFee: 20,
                distanceKm: 13.09,
                roadDistanceKm: 13.09,
                deliveryMode: 'basic'
            },
            payment: { method: 'wallet', status: 'paid' },
            deliveryAddress: {
                street: 'x',
                city: 'y',
                state: 'z',
                location: { type: 'Point', coordinates: [78.41, 17.43] }
            },
            orderStatus: 'preparing',
            dispatch: { status: 'accepted', deliveryPartnerId: rider }
        });
        await createInitialTransaction(order);

        const trip = await getCurrentTripDelivery(rider);

        assert.equal(trip.pricing.roadDistanceKm, 13.09, 'road distance survives the transaction merge');
        assert.equal(trip.pricing.distanceKm, 13.09);
        assert.equal(trip.pricing.deliveryMode, 'basic');
        assert.equal(trip.pricing.total, 158, 'the money lines still come from the transaction');
    });
});
