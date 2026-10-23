import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb } from './helpers/db.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodZone } from '../src/modules/food/admin/models/zone.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import * as pos from '../src/modules/food/restaurant/services/pos.service.js';
import { getRestaurantMenu } from '../src/modules/food/restaurant/services/restaurantMenu.service.js';

/**
 * Loose produce at the till: sold by weight (1.250 kg), priced per kilogram, stock counted in kg,
 * with an optional dearer rate under half a kilo. Everything else is still whole units only.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const fails = (promise, pattern) => assert.rejects(promise, { message: pattern });

const setup = async () => {
    await FoodZone.create({
        name: 'Test Zone',
        coordinates: [
            { latitude: 12.9, longitude: 77.5 },
            { latitude: 12.9, longitude: 77.7 },
            { latitude: 13.05, longitude: 77.7 },
            { latitude: 13.05, longitude: 77.5 }
        ]
    });
    const shop = await FoodRestaurant.create({
        restaurantName: 'Corner Store',
        ownerName: 'Owner',
        ownerPhone: '9000000001',
        phone: '9000000001',
        status: 'approved',
        addressLine1: '12 Market Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        location: { type: 'Point', coordinates: [77.59, 12.97] }
    });
    const tomato = await FoodItem.create({
        restaurantId: shop._id,
        name: 'Tomato',
        price: 40,
        stockQty: 10,
        gstRate: 0,
        soldByWeight: true,
        smallQtyRate: 50
    });
    const plain = await FoodItem.create({
        restaurantId: shop._id,
        name: 'Milk',
        price: 30,
        stockQty: 10,
        gstRate: 0,
        soldByWeight: true
    });
    const milk = await FoodItem.create({ restaurantId: shop._id, name: 'Packet milk', price: 60, stockQty: 10, gstRate: 0 });
    const sell = (item, quantity) =>
        pos.createPosOrder(shop._id, { items: [{ itemId: String(item._id), quantity }], paymentMode: 'cash' });
    return { shop, tomato, plain, milk, sell };
};

describe('a weight at the till', () => {
    it('prices a weighed item by the kilogram', async () => {
        const { shop, plain } = await setup();
        const q = await pos.quotePosOrder(shop._id, { items: [{ itemId: String(plain._id), quantity: 1.25 }] });
        assert.equal(q.pricing.subtotal, 37.5);
        assert.equal(q.items[0].quantity, 1.25);
    });

    it('uses the small-quantity rate under half a kilo, and the normal rate from half a kilo up', async () => {
        const { shop, tomato } = await setup();
        const small = await pos.quotePosOrder(shop._id, { items: [{ itemId: String(tomato._id), quantity: 0.3 }] });
        assert.equal(small.pricing.subtotal, 15, '0.3 kg at the 50/kg small-quantity rate');
        const half = await pos.quotePosOrder(shop._id, { items: [{ itemId: String(tomato._id), quantity: 0.5 }] });
        assert.equal(half.pricing.subtotal, 20, '0.5 kg is not "small": 40/kg');
        const big = await pos.quotePosOrder(shop._id, { items: [{ itemId: String(tomato._id), quantity: 2 }] });
        assert.equal(big.pricing.subtotal, 80);
    });

    it('keeps the gram a jittery scale reports, and no finer', async () => {
        const { shop, plain } = await setup();
        await fails(pos.quotePosOrder(shop._id, { items: [{ itemId: String(plain._id), quantity: 1.2504 }] }), /to the gram/);
        await fails(pos.quotePosOrder(shop._id, { items: [{ itemId: String(plain._id), quantity: 0 }] }), /to the gram|whole number/);
    });

    it('sells it: the bill records the weight and the stock falls by that many kilograms', async () => {
        const { tomato, sell } = await setup();
        const { order } = await sell(tomato, 1.25);
        const saved = await FoodOrder.findById(order._id).lean();
        assert.equal(saved.items[0].quantity, 1.25);
        assert.equal(saved.pricing.subtotal, 50, '1.25 kg at 40/kg');
        assert.equal((await FoodItem.findById(tomato._id).lean()).stockQty, 8.75);
    });

    it('refuses more than is on the shelf, in kilograms', async () => {
        const { tomato, sell } = await setup();
        await fails(sell(tomato, 10.5), /Only 10 left|reduce the quantity/);
        assert.equal((await FoodItem.findById(tomato._id).lean()).stockQty, 10, 'nothing taken');
    });
});

describe('everything else is still by the piece', () => {
    it('refuses a fraction of a packet', async () => {
        const { shop, milk } = await setup();
        await fails(pos.quotePosOrder(shop._id, { items: [{ itemId: String(milk._id), quantity: 1.5 }] }), /whole number/);
    });

    it('sells whole packets as before', async () => {
        const { milk, sell } = await setup();
        await sell(milk, 2);
        assert.equal((await FoodItem.findById(milk._id).lean()).stockQty, 8);
    });
});

describe('the menu tells the till what is weighed', () => {
    it('flags weighed items and carries the small-quantity rate', async () => {
        const { shop } = await setup();
        const menu = await getRestaurantMenu(shop._id);
        const items = (menu.sections || []).flatMap((s) => s.items || []);
        const tomato = items.find((i) => i.name === 'Tomato');
        const packet = items.find((i) => i.name === 'Packet milk');
        assert.equal(tomato?.soldByWeight, true);
        assert.equal(tomato?.smallQtyRate, 50);
        assert.equal(packet?.soldByWeight, false);
    });
});
