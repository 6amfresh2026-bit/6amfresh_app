import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, someId } from './helpers/db.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodZone } from '../src/modules/food/admin/models/zone.model.js';
import { FoodOffer } from '../src/modules/food/admin/models/offer.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { FoodUser } from '../src/core/users/user.model.js';
import * as pos from '../src/modules/food/restaurant/services/pos.service.js';
import { createRestaurantOffer } from '../src/modules/food/restaurant/services/restaurant.service.js';
import { validateCreateOfferDto } from '../src/modules/food/admin/validators/offer.validator.js';
import {
    evaluateCoupon,
    couponDiscountFor,
    describeCoupon,
    nextSlabFor,
    couponEntryThreshold
} from '../src/modules/food/orders/services/coupon-eligibility.service.js';

/**
 * Spend-slab coupons — "₹50 off above ₹300, ₹120 off above ₹600".
 *
 * The rungs are judged in the one place the cart, the checkout and the till
 * all read from, so the suite that matters most is the last one: whatever the
 * till's list offers, the bill has to honour.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const SHOP_LNG = 77.59;
const SHOP_LAT = 12.97;

const makeShop = async () => {
    await FoodZone.create({
        name: 'Test Zone',
        coordinates: [
            { latitude: 12.9, longitude: 77.5 },
            { latitude: 12.9, longitude: 77.7 },
            { latitude: 13.05, longitude: 77.7 },
            { latitude: 13.05, longitude: 77.5 }
        ]
    });
    return FoodRestaurant.create({
        restaurantName: 'Corner Store',
        ownerName: 'Owner',
        ownerPhone: '9000000001',
        phone: '9000000001',
        status: 'approved',
        addressLine1: '12 Market Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        location: { type: 'Point', coordinates: [SHOP_LNG, SHOP_LAT] }
    });
};

const makeProduct = (restaurantId, over = {}) =>
    FoodItem.create({ restaurantId, name: 'Milk', price: 100, stockQty: 500, gstRate: 0, ...over });

/** The campaign from the brief: spend ₹300 get ₹50, and two rungs above it. */
const LADDER = [
    { minOrderValue: 300, discountType: 'flat-price', discountValue: 50, maxDiscount: null },
    { minOrderValue: 600, discountType: 'flat-price', discountValue: 120, maxDiscount: null },
    { minOrderValue: 1000, discountType: 'percentage', discountValue: 25, maxDiscount: 250 }
];

const ladderOffer = (over = {}) => ({
    _id: someId(),
    status: 'active',
    discountMode: 'slab',
    slabs: LADDER,
    discountType: 'flat-price',
    discountValue: 50,
    minOrderValue: 300,
    ...over
});

const baseDto = (over = {}) => ({
    couponCode: 'LADDER',
    customerScope: 'all',
    restaurantScope: 'all',
    ...over
});

describe('what a slab coupon takes off', () => {
    it('pays the rung the basket has reached, and nothing below the first', () => {
        const o = ladderOffer();
        assert.equal(couponDiscountFor(o, 299), 0, 'under the bottom rung');
        assert.equal(couponDiscountFor(o, 300), 50, 'exactly on the bottom rung');
        assert.equal(couponDiscountFor(o, 599), 50);
        assert.equal(couponDiscountFor(o, 600), 120);
        assert.equal(couponDiscountFor(o, 999), 120);
        assert.equal(couponDiscountFor(o, 1000), 250, '25% of 1000, at the cap');
        assert.equal(couponDiscountFor(o, 2000), 250, 'still capped at ₹250');
    });

    it('reads the rungs in order however they were stored', () => {
        const shuffled = ladderOffer({ slabs: [LADDER[2], LADDER[0], LADDER[1]] });
        assert.equal(couponDiscountFor(shuffled, 600), 120);
        assert.equal(couponEntryThreshold(shuffled), 300);
    });

    it('never charges the customer for a campaign written backwards', () => {
        // A higher rung that pays less is a typo, not a rule. The customer keeps
        // the better of the rungs they have reached.
        const wrong = ladderOffer({
            slabs: [
                { minOrderValue: 300, discountType: 'flat-price', discountValue: 50 },
                { minOrderValue: 600, discountType: 'flat-price', discountValue: 40 }
            ]
        });
        assert.equal(couponDiscountFor(wrong, 700), 50, 'the better rung wins, not the higher one');
    });

    it('still cannot take a bill below zero', () => {
        const o = ladderOffer({
            slabs: [{ minOrderValue: 0, discountType: 'flat-price', discountValue: 500 }]
        });
        assert.equal(couponDiscountFor(o, 100), 100);
    });

    it('leaves a single-threshold coupon exactly as it was', () => {
        assert.equal(couponDiscountFor({ discountType: 'flat-price', discountValue: 50 }, 500), 50);
        assert.equal(couponDiscountFor({ discountType: 'percentage', discountValue: 10, maxDiscount: 20 }, 500), 20);
        // slabs present but the mode never switched: ignored, not silently used
        assert.equal(couponDiscountFor({ discountType: 'flat-price', discountValue: 50, slabs: LADDER }, 1000), 50);
    });

    it('reads the terms out rung by rung', () => {
        assert.equal(
            describeCoupon(ladderOffer()),
            '₹50 off above ₹300, ₹120 off above ₹600, 25% off, up to ₹250 above ₹1000'
        );
    });
});

describe('the rung above', () => {
    it('says what one more rung is worth, and what it costs to get there', () => {
        assert.deepEqual(nextSlabFor(ladderOffer(), 420), { minOrderValue: 600, spendMore: 180, discount: 120 });
        assert.deepEqual(nextSlabFor(ladderOffer(), 600), { minOrderValue: 1000, spendMore: 400, discount: 250 });
    });

    it('quotes what the rung pays at its own threshold, not on the basket in hand', () => {
        // 25% of ₹1000 is ₹250. Quoting 25% of the current ₹420 basket, or of
        // some imagined larger one, would promise a number the customer would
        // not actually get by spending exactly ₹1000.
        const pct = ladderOffer({
            slabs: [{ minOrderValue: 1000, discountType: 'percentage', discountValue: 25, maxDiscount: 250 }]
        });
        assert.equal(nextSlabFor(pct, 420).discount, 250);
    });

    it('has nothing to say on the top rung, or for a coupon without slabs', () => {
        assert.equal(nextSlabFor(ladderOffer(), 1500), null);
        assert.equal(nextSlabFor({ discountType: 'flat-price', discountValue: 50 }, 100), null);
    });

    it('does not dangle a rung that pays no better', () => {
        const flat = ladderOffer({
            slabs: [
                { minOrderValue: 300, discountType: 'flat-price', discountValue: 50 },
                { minOrderValue: 900, discountType: 'flat-price', discountValue: 50 }
            ]
        });
        assert.equal(nextSlabFor(flat, 400), null, 'spending ₹500 more for the same ₹50 is not an offer');
    });
});

describe('refusing a slab coupon', () => {
    it('names the bottom rung as the shortfall', () => {
        const v = evaluateCoupon(ladderOffer(), { subtotal: 180, restaurantId: String(someId()) });
        assert.equal(v.eligible, false);
        assert.equal(v.reason, 'Needs ₹300 minimum — ₹120 more');
    });

    it('carries the next rung on an eligible verdict', () => {
        const v = evaluateCoupon(ladderOffer(), { subtotal: 350, restaurantId: String(someId()) });
        assert.equal(v.eligible, true);
        assert.equal(v.discount, 50);
        assert.deepEqual(v.nextSlab, { minOrderValue: 600, spendMore: 250, discount: 120 });
    });
});

describe('setting one up', () => {
    it('accepts the campaign from the brief and sorts the rungs', () => {
        const dto = validateCreateOfferDto(baseDto({
            discountMode: 'slab',
            slabs: [
                { minOrderValue: 600, discountValue: 120 },
                { minOrderValue: 300, discountValue: 50 }
            ]
        }));
        assert.equal(dto.discountMode, 'slab');
        assert.deepEqual(dto.slabs.map((s) => s.minOrderValue), [300, 600]);
    });

    it('mirrors the bottom rung onto the single-mode fields', () => {
        // Anything still reading discountType/discountValue/minOrderValue — a
        // report, an old list column — sees the entry rung rather than nothing.
        const dto = validateCreateOfferDto(baseDto({
            discountMode: 'slab',
            slabs: [{ minOrderValue: 300, discountValue: 50 }]
        }));
        assert.equal(dto.discountType, 'flat-price');
        assert.equal(dto.discountValue, 50);
        assert.equal(dto.minOrderValue, 300);
    });

    it('refuses a slab coupon with no slabs', () => {
        assert.throws(
            () => validateCreateOfferDto(baseDto({ discountMode: 'slab', slabs: [] })),
            /at least one slab/i
        );
    });

    it('refuses two rungs starting at the same spend', () => {
        assert.throws(
            () => validateCreateOfferDto(baseDto({
                discountMode: 'slab',
                slabs: [
                    { minOrderValue: 300, discountValue: 50 },
                    { minOrderValue: 300, discountValue: 70 }
                ]
            })),
            /both start at ₹300/
        );
    });

    it('refuses a percentage rung with no cap', () => {
        assert.throws(
            () => validateCreateOfferDto(baseDto({
                discountMode: 'slab',
                slabs: [{ minOrderValue: 1000, discountType: 'percentage', discountValue: 25 }]
            })),
            /needs a maximum discount/
        );
    });

    it('refuses a rung that gives the order away', () => {
        assert.throws(
            () => validateCreateOfferDto(baseDto({
                discountMode: 'slab',
                slabs: [{ minOrderValue: 300, discountValue: 500 }]
            })),
            /gives the order away/
        );
    });

    it('leaves an ordinary coupon alone', () => {
        const dto = validateCreateOfferDto(baseDto({ discountType: 'flat-price', discountValue: 50, minOrderValue: 300 }));
        assert.equal(dto.discountMode, 'single');
        assert.deepEqual(dto.slabs, []);
        assert.equal(dto.discountValue, 50);
    });
});

describe('only the admin writes one', () => {
    it('refuses a store that tries to create a slab campaign', async () => {
        const shop = await makeShop();
        await assert.rejects(
            createRestaurantOffer(String(shop._id), {
                couponCode: 'STORESLAB',
                discountType: 'flat-price',
                discountValue: 50,
                discountMode: 'slab',
                slabs: [{ minOrderValue: 300, discountValue: 50 }]
            }),
            /set up by the admin/i
        );
        assert.equal(await FoodOffer.countDocuments({ couponCode: 'STORESLAB' }), 0);
    });

    it('still lets a store create an ordinary one, with no slabs on it', async () => {
        const shop = await makeShop();
        const doc = await createRestaurantOffer(String(shop._id), {
            couponCode: 'STOREFLAT',
            discountType: 'flat-price',
            discountValue: 20,
            minOrderValue: 100
        });
        assert.equal(doc.discountMode, 'single');
        assert.deepEqual([...doc.slabs], []);
    });
});

describe('the till list and the bill never disagree about a rung', () => {
    it('gives the same figure at every step of the ladder', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 100 });
        const customer = await FoodUser.create({ phone: '9844444444', name: 'Climber' });

        await FoodOffer.create({
            couponCode: 'LADDER',
            discountMode: 'slab',
            slabs: LADDER,
            discountType: 'flat-price',
            discountValue: 50,
            minOrderValue: 300
        });

        // ₹200 under the bottom rung, then ₹300 / ₹600 / ₹1000 on each rung.
        for (const [qty, expected] of [[2, 0], [3, 50], [6, 120], [10, 250]]) {
            const items = [{ itemId: String(milk._id), quantity: qty }];
            const { coupons } = await pos.listPosCoupons(shop._id, { items, customerId: String(customer._id) });
            const row = coupons.find((c) => c.code === 'LADDER');
            assert.ok(row, 'the campaign is listed at every basket size');

            const quote = await pos.quotePosOrder(shop._id, {
                items,
                customerId: String(customer._id),
                couponCode: 'LADDER'
            });

            assert.equal(quote.pricing.discount, expected, `₹${qty * 100} basket should save ₹${expected}`);
            if (expected === 0) {
                assert.equal(row.eligible, false);
                assert.equal(row.reason, 'Needs ₹300 minimum — ₹100 more');
            } else {
                assert.equal(row.eligible, true);
                assert.equal(row.discount, expected, 'the list promised what the bill gave');
            }
        }
    });
});
