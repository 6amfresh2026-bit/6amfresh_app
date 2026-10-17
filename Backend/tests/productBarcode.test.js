import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, expectError, resetDb, someId } from './helpers/db.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodZone } from '../src/modules/food/admin/models/zone.model.js';
import { FoodCounter } from '../src/modules/food/admin/models/counter.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import * as pos from '../src/modules/food/restaurant/services/pos.service.js';
import {
    assignMissingBarcodes,
    barcodeFromSequence,
    generateBarcode,
    isValidEan13
} from '../src/modules/food/shared/productBarcode.js';

/**
 * Barcodes for products that arrive without one, and the barcode printed under each
 * item on a counter bill.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const shop = (over = {}) =>
    FoodRestaurant.create({
        restaurantName: 'Corner Store',
        ownerName: 'Owner',
        ownerPhone: '9000000001',
        phone: '9000000001',
        status: 'approved',
        addressLine1: '12 Market Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        location: { type: 'Point', coordinates: [77.59, 12.97] },
        ...over
    });

const product = (restaurantId, over = {}) =>
    FoodItem.create({ restaurantId, name: 'Milk', price: 50, stockQty: 20, gstRate: 0, ...over });

describe('generated barcodes', () => {
    it('are valid EAN-13s in the in-store range', () => {
        for (const seq of [1, 2, 41, 999999, 9999999999]) {
            const code = barcodeFromSequence(seq);
            assert.equal(code.length, 13);
            assert.ok(code.startsWith('29'), code);
            assert.ok(isValidEan13(code), code);
        }
        assert.equal(barcodeFromSequence(1), '2900000000018');
    });

    it('stop before the counter outgrows twelve digits', () => {
        assert.throws(() => barcodeFromSequence(10 ** 10), /no longer fits/);
    });

    it('rejects a wrong check digit', () => {
        assert.ok(!isValidEan13('2900000000016'));
        assert.ok(!isValidEan13('290000000001'));
        assert.ok(!isValidEan13('abcdefghijklm'));
    });

    it('never repeat, and skip a code someone typed in by hand', async () => {
        const store = await shop();
        const first = await generateBarcode();
        const taken = barcodeFromSequence((await FoodCounter.findById('food_item_barcode').lean()).seq + 1);
        await product(store._id, { barcode: taken });

        const next = await generateBarcode();
        assert.notEqual(next, taken, 'a barcode another product already has must be skipped');
        assert.notEqual(next, first);
    });
});

describe('assignMissingBarcodes', () => {
    it('gives a barcode to products without one and leaves the others alone', async () => {
        const store = await shop();
        const bare = await product(store._id, { name: 'Bare' });
        const blank = await product(store._id, { name: 'Blank', barcode: '' });
        const has = await product(store._id, { name: 'Has', barcode: '8901234567890' });

        const out = await assignMissingBarcodes([bare._id, blank._id, has._id].map(String), { restaurantId: store._id });
        const byId = Object.fromEntries(out.map((r) => [r.id, r]));

        assert.ok(isValidEan13(byId[String(bare._id)].barcode));
        assert.equal(byId[String(bare._id)].generated, true);
        assert.ok(isValidEan13(byId[String(blank._id)].barcode));
        assert.equal(byId[String(has._id)].barcode, '8901234567890', 'an existing barcode is never replaced');
        assert.equal(byId[String(has._id)].generated, false);

        const saved = await FoodItem.findById(bare._id).lean();
        assert.equal(saved.barcode, byId[String(bare._id)].barcode, 'and it is written to the product');
    });

    it('gives every product a different barcode', async () => {
        const store = await shop();
        const items = await Promise.all(Array.from({ length: 12 }, (_, i) => product(store._id, { name: `P${i}` })));
        const out = await assignMissingBarcodes(items.map((i) => String(i._id)));
        assert.equal(new Set(out.map((r) => r.barcode)).size, 12);
    });

    it('settles on one barcode when the same product is asked for in parallel', async () => {
        const store = await shop();
        const item = await product(store._id);
        const runs = await Promise.all(
            Array.from({ length: 8 }, () => assignMissingBarcodes([String(item._id)], { restaurantId: store._id }))
        );
        const codes = new Set(runs.map((r) => r[0].barcode));
        assert.equal(codes.size, 1, 'every caller must see the same barcode');
        assert.equal((await FoodItem.findById(item._id).lean()).barcode, [...codes][0]);
        assert.equal(runs.filter((r) => r[0].generated).length >= 1, true);
    });

    it('stays inside one seller when given a restaurant', async () => {
        const mine = await shop();
        const theirs = await shop({ ownerPhone: '9000000002', phone: '9000000002' });
        const own = await product(mine._id);
        const other = await product(theirs._id);

        const out = await assignMissingBarcodes([String(own._id), String(other._id)], { restaurantId: mine._id });
        assert.deepEqual(out.map((r) => r.id), [String(own._id)]);
        assert.equal((await FoodItem.findById(other._id).lean()).barcode || '', '', "another seller's product is untouched");
    });

    it('ignores deleted products', async () => {
        const store = await shop();
        const gone = await product(store._id, { isDeleted: true });
        const out = await assignMissingBarcodes([String(gone._id)]);
        assert.deepEqual(out, []);
    });

    it('validates the request', async () => {
        await expectError(() => assignMissingBarcodes([]), 'at least one', assert);
        await expectError(() => assignMissingBarcodes(undefined), 'at least one', assert);
        await expectError(() => assignMissingBarcodes(['not-an-id']), 'Invalid product id', assert);
        await expectError(
            () => assignMissingBarcodes(Array.from({ length: 501 }, () => String(someId()))),
            'at most 500',
            assert
        );
    });
});

describe('barcodes on the counter bill', () => {
    const zone = () =>
        FoodZone.create({
            name: 'Test Zone',
            coordinates: [
                { latitude: 12.9, longitude: 77.5 },
                { latitude: 12.9, longitude: 77.7 },
                { latitude: 13.05, longitude: 77.7 },
                { latitude: 13.05, longitude: 77.5 }
            ]
        });

    it("carry each item's barcode, falling back to its item code", async () => {
        await zone();
        const store = await shop();
        const withBarcode = await product(store._id, { name: 'Milk', barcode: '8901234567890', itemCode: 'PRD0000000001' });
        const codeOnly = await product(store._id, { name: 'Bread', barcode: '', itemCode: 'PRD0000000002' });
        const neither = await product(store._id, { name: 'Loose', barcode: '', itemCode: '' });

        const { receipt } = await pos.createPosOrder(store._id, {
            items: [withBarcode, codeOnly, neither].map((p) => ({ itemId: String(p._id), quantity: 1 })),
            orderType: 'take_away',
            paymentMode: 'cash'
        });

        const byName = Object.fromEntries(receipt.items.map((i) => [i.name, i.barcode]));
        assert.equal(byName.Milk, '8901234567890');
        assert.equal(byName.Bread, 'PRD0000000002');
        assert.equal(byName.Loose, '');
    });

    it('also appear when the bill is looked up or reprinted later', async () => {
        await zone();
        const store = await shop();
        const milk = await product(store._id, { name: 'Milk', barcode: '8901234567890' });
        const { order } = await pos.createPosOrder(store._id, {
            items: [{ itemId: String(milk._id), quantity: 1 }],
            orderType: 'take_away',
            paymentMode: 'cash'
        });

        assert.equal((await pos.getLastPosBill(store._id)).items[0].barcode, '8901234567890');
        assert.equal((await pos.getPosBill(store._id, String(order._id))).items[0].barcode, '8901234567890');
        const listed = await pos.listPosOrders(store._id, { date: 'all' });
        assert.equal(listed.items[0].items[0].barcode, '8901234567890');

        // a barcode assigned after the sale shows up on the reprint
        const late = await product(store._id, { name: 'Late' });
        const second = await pos.createPosOrder(store._id, {
            items: [{ itemId: String(late._id), quantity: 1 }],
            orderType: 'take_away',
            paymentMode: 'cash'
        });
        assert.equal(second.receipt.items[0].barcode, '');
        const [{ barcode }] = await assignMissingBarcodes([String(late._id)]);
        assert.equal((await pos.getPosBill(store._id, String(second.order._id))).items[0].barcode, barcode);
    });
});
