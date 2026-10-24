import { after, before, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb } from './helpers/db.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { listPublicFoods } from '../src/modules/food/restaurant/services/publicFoods.service.js';
import { getPublicApprovedRestaurantMenu } from '../src/modules/food/restaurant/services/restaurantMenu.service.js';
import { searchProducts } from '../src/modules/food/search/services/search.service.js';

/**
 * A closed store's products are not listed.
 *
 * Checkout already refuses a closed store; these pin the other half, that the lists a customer
 * browses stop offering what checkout would then refuse. "Closed" is whatever the shared
 * availability check says: the admin's App timings, the seller's pause switch, or a deactivated
 * store, so each is covered through the real check rather than a stub.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);
afterEach(() => {
    delete process.env.HIDE_CLOSED_STORE_PRODUCTS;
});

const makeShop = (name, over = {}) =>
    FoodRestaurant.create({
        restaurantName: name,
        ownerName: 'Owner',
        ownerPhone: '9000000001',
        phone: '9000000001',
        status: 'approved',
        ...over
    });

const makeProduct = (restaurantId, name) =>
    FoodItem.create({ restaurantId, name, price: 50, approvalStatus: 'approved', isAvailable: true });

const names = (foods) => foods.map((f) => f.name).sort();

describe('products of a closed store', () => {
    it('are listed while the store is open and gone when the admin forces it closed', async () => {
        const open = await makeShop('Open Mart');
        const shut = await makeShop('Shut Mart', { appTimings: { customerMode: 'closed' } });
        await makeProduct(open._id, 'Milk');
        await makeProduct(shut._id, 'Bread');

        const { foods } = await listPublicFoods({});
        assert.deepEqual(names(foods), ['Milk']);
    });

    it('are gone when the seller has paused the store', async () => {
        const paused = await makeShop('Paused Mart', { isAcceptingOrders: false });
        await makeProduct(paused._id, 'Eggs');
        const { foods } = await listPublicFoods({});
        assert.deepEqual(foods, []);
    });

    it('are gone when the till is required online and has not checked in', async () => {
        const noTill = await makeShop('Till Mart', { appTimings: { requirePosOnline: true } });
        await makeProduct(noTill._id, 'Tea');
        assert.deepEqual((await listPublicFoods({})).foods, []);

        await FoodRestaurant.updateOne({ _id: noTill._id }, { $set: { posLastSeenAt: new Date() } });
        assert.deepEqual(names((await listPublicFoods({})).foods), ['Tea']);
    });

    it('come back as soon as the admin sets the store to follow its hours again', async () => {
        const shop = await makeShop('Flip Mart', { appTimings: { customerMode: 'closed' } });
        await makeProduct(shop._id, 'Salt');
        assert.deepEqual((await listPublicFoods({})).foods, []);

        await FoodRestaurant.updateOne({ _id: shop._id }, { $set: { 'appTimings.customerMode': 'follow' } });
        assert.deepEqual(names((await listPublicFoods({})).foods), ['Salt']);
    });

    it('are dropped from product search too, and the open store keeps its products', async () => {
        const open = await makeShop('Open Mart');
        const shut = await makeShop('Shut Mart', { appTimings: { customerMode: 'closed' } });
        await makeProduct(open._id, 'Amul Milk');
        await makeProduct(shut._id, 'Amul Butter');

        const found = await searchProducts({ q: 'amul' });
        assert.deepEqual(names(found.products), ['Amul Milk']);
        assert.equal(found.total, 1);
    });

    it('leave the store page empty but explain why', async () => {
        const shut = await makeShop('Shut Mart', {
            appTimings: { customerMode: 'closed', closedMessage: 'Back at 6 AM tomorrow' }
        });
        await makeProduct(shut._id, 'Curd');

        const menu = await getPublicApprovedRestaurantMenu(String(shut._id));
        assert.deepEqual(menu.sections, []);
        assert.deepEqual(menu.categories, []);
        assert.equal(menu.store.open, false);
        assert.equal(menu.store.reason, 'app-forced-closed');
        assert.equal(menu.store.message, 'Back at 6 AM tomorrow');
    });

    it('show on the store page of an open store, which says it is open', async () => {
        const open = await makeShop('Open Mart');
        await makeProduct(open._id, 'Curd');
        const menu = await getPublicApprovedRestaurantMenu(String(open._id));
        assert.equal(menu.store.open, true);
        assert.equal(menu.sections.reduce((n, s) => n + s.items.length, 0), 1);
    });

    it('can be shown again with the switch HIDE_CLOSED_STORE_PRODUCTS=false', async () => {
        const shut = await makeShop('Shut Mart', { appTimings: { customerMode: 'closed' } });
        await makeProduct(shut._id, 'Bread');
        process.env.HIDE_CLOSED_STORE_PRODUCTS = 'false';
        assert.deepEqual(names((await listPublicFoods({})).foods), ['Bread']);
    });
});
