import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, expectError, resetDb } from './helpers/db.js';
import * as admin from '../src/modules/food/admin/services/admin.service.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';

/**
 * A product's expiry date, from the admin form to the database and back.
 *
 * The field existed on the model and the seller could set it, but the admin
 * product form had no input for it and the admin create/update path dropped it
 * on the floor — a value typed into a form that silently never arrives is
 * worse than no field at all.
 *
 * The rules worth pinning are the ones a careless mapping breaks: that it
 * survives the round trip, that it can be cleared, that an unrelated edit
 * leaves it alone, and that a date nobody can parse is refused rather than
 * cast to null behind a success message.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const aStore = () =>
    FoodRestaurant.create({
        restaurantName: 'Corner Store',
        ownerName: 'Owner',
        ownerPhone: '9000000000',
        phone: '9000000000'
    });

const aProduct = (restaurantId, over = {}) =>
    admin.createFood({
        restaurantId: String(restaurantId),
        name: 'Amul Gold Milk 1L',
        categoryName: 'Dairy',
        price: 72,
        ...over
    });

describe('a product expiry set from the admin panel', () => {
    it('survives the round trip to the edit form', async () => {
        const store = await aStore();
        const created = await aProduct(store._id, { expiryDate: '2027-03-10' });

        assert.equal(new Date(created.expiryDate).toISOString(), '2027-03-10T00:00:00.000Z');

        // What the edit form actually reads. The create path and the read path
        // are separate mappings, and a field present in one and missing from
        // the other looks exactly like a save that did not work.
        const loaded = await admin.getFoodById(String(created._id));
        assert.equal(new Date(loaded.expiryDate).toISOString(), '2027-03-10T00:00:00.000Z');
    });

    it('can be set on a product that had none, and cleared again', async () => {
        const store = await aStore();
        const created = await aProduct(store._id);
        assert.equal(created.expiryDate, null, 'nothing expires until somebody says so');

        await admin.updateFood(String(created._id), { expiryDate: '2026-12-31' });
        assert.equal(
            new Date((await admin.getFoodById(String(created._id))).expiryDate).toISOString(),
            '2026-12-31T00:00:00.000Z'
        );

        // An emptied date input arrives as '', which has to mean "does not
        // expire" rather than being ignored as a blank nobody typed.
        await admin.updateFood(String(created._id), { expiryDate: '' });
        assert.equal((await admin.getFoodById(String(created._id))).expiryDate, null);
    });

    it('is left alone by an edit that never mentions it', async () => {
        const store = await aStore();
        const created = await aProduct(store._id, { expiryDate: '2027-03-10' });

        await admin.updateFood(String(created._id), { price: 75 });

        const loaded = await admin.getFoodById(String(created._id));
        assert.equal(new Date(loaded.expiryDate).toISOString(), '2027-03-10T00:00:00.000Z');
    });

    it('refuses a date nobody can parse instead of quietly dropping it', async () => {
        const store = await aStore();
        const created = await aProduct(store._id, { expiryDate: '2027-03-10' });

        // Invalid Date casts to null, so without the guard the admin would be
        // told the save worked and the expiry would simply have vanished.
        await expectError(
            () => admin.updateFood(String(created._id), { expiryDate: 'next tuesday' }),
            'Expiry date is invalid',
            assert
        );

        const loaded = await admin.getFoodById(String(created._id));
        assert.equal(
            new Date(loaded.expiryDate).toISOString(),
            '2027-03-10T00:00:00.000Z',
            'a rejected edit must not take the old date with it'
        );
    });
});
