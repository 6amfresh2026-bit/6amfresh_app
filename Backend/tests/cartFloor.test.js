import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveCartAdjustments,
    resolveUserDeliveryFee
} from '../src/modules/food/orders/services/order-pricing.service.js';

/**
 * A floor under the basket.
 *
 * A rider rides the same distance for a ₹30 order as a ₹400 one, and the
 * system had no floor of any kind — the small one was delivered at a
 * guaranteed loss. A surcharge rather than a hard minimum: refusing the order
 * loses the customer, charging for the trip only prices it.
 */

const settings = (over = {}) => ({
    deliveryFee: 20,
    deliveryFeeRanges: [],
    smallCartThreshold: 200,
    smallCartFee: 25,
    freeDeliveryAbove: 500,
    ...over
});

describe('a small basket', () => {
    it('is surcharged below the threshold', () => {
        assert.equal(resolveCartAdjustments(settings(), 150).smallCartFee, 25);
    });

    it('is not surcharged at the threshold itself', () => {
        assert.equal(resolveCartAdjustments(settings(), 200).smallCartFee, 0);
        assert.equal(resolveCartAdjustments(settings(), 201).smallCartFee, 0);
    });

    it('does not surcharge an empty cart', () => {
        // Nothing has been ordered; the surcharge would be the entire bill.
        assert.equal(resolveCartAdjustments(settings(), 0).smallCartFee, 0);
    });

    it('stays off entirely until an admin configures it', () => {
        // Every existing installation, which must not suddenly start charging.
        assert.equal(resolveCartAdjustments({}, 10).smallCartFee, 0);
        assert.equal(resolveCartAdjustments(settings({ smallCartFee: 0 }), 10).smallCartFee, 0);
        assert.equal(resolveCartAdjustments(settings({ smallCartThreshold: 0 }), 10).smallCartFee, 0);
    });
});

describe('free delivery over a threshold', () => {
    it('waives the distance fee at and above the threshold', () => {
        const s = settings({ deliveryFeeRanges: [{ min: 0, max: 5, fee: 40 }] });
        assert.equal(resolveUserDeliveryFee(s, { subtotal: 499, distanceKm: 2 }).deliveryFee, 40);
        assert.equal(resolveUserDeliveryFee(s, { subtotal: 500, distanceKm: 2 }).deliveryFee, 0);
        assert.equal(resolveUserDeliveryFee(s, { subtotal: 900, distanceKm: 2 }).source, 'free_over_threshold');
    });

    it('waives the flat fee too, not only the banded one', () => {
        assert.equal(resolveUserDeliveryFee(settings(), { subtotal: 600, distanceKm: null }).deliveryFee, 0);
    });

    it('says how much more would earn it', () => {
        assert.equal(resolveCartAdjustments(settings(), 430).spendMoreForFreeDelivery, 70);
        assert.equal(resolveCartAdjustments(settings(), 500).spendMoreForFreeDelivery, 0, 'already there');
    });

    it('stays off until configured, so the fee applies as it always did', () => {
        const s = settings({ freeDeliveryAbove: 0, deliveryFeeRanges: [{ min: 0, max: 5, fee: 40 }] });
        assert.equal(resolveUserDeliveryFee(s, { subtotal: 10000, distanceKm: 2 }).deliveryFee, 40);
    });
});

describe('the two together', () => {
    it('cannot both surcharge a basket and call its delivery free', () => {
        // They sit either side of the same number line; a basket is small or
        // large, never both.
        for (const goods of [0, 1, 199, 200, 499, 500, 5000]) {
            const r = resolveCartAdjustments(settings(), goods);
            assert.ok(!(r.smallCartFee > 0 && r.deliveryIsFree), `₹${goods} was charged both ways`);
        }
    });
});
