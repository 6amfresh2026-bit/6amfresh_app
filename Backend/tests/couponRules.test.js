import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateCreateOfferDto } from '../src/modules/food/admin/validators/offer.validator.js';

/**
 * What the coupon API accepts.
 *
 * A percentage coupon with no cap is an open-ended giveaway: 50% off a large
 * basket costs whatever the basket costs. The server refuses it, and the seller
 * form has to say so up front rather than failing on submit with a raw field
 * name -- which is how it read before.
 */

const percentage = (over = {}) => ({
    couponCode: 'SAVE10',
    discountType: 'percentage',
    discountValue: 10,
    minOrderValue: 100,
    maxDiscount: 50,
    startDate: '2026-10-02',
    endDate: '2026-12-31',
    ...over
});

describe('a percentage coupon', () => {
    it('is accepted with a cap', () => {
        const dto = validateCreateOfferDto(percentage());
        assert.equal(dto.discountType, 'percentage');
        assert.equal(dto.maxDiscount, 50);
    });

    it('is refused without a cap', () => {
        assert.throws(() => validateCreateOfferDto(percentage({ maxDiscount: undefined })), /maxDiscount is required/i);
    });

    it('is refused when the cap is not a number', () => {
        assert.throws(() => validateCreateOfferDto(percentage({ maxDiscount: Number.NaN })), /maxDiscount|Invalid|number/i);
    });

    it('is refused with a non-positive discount', () => {
        assert.throws(() => validateCreateOfferDto(percentage({ discountValue: 0 })), /greater than 0/i);
    });
});

describe('a flat coupon', () => {
    it('does not need a cap, and any cap sent is ignored', () => {
        const noCap = validateCreateOfferDto(percentage({ discountType: 'flat-price', discountValue: 50, maxDiscount: undefined }));
        assert.equal(noCap.maxDiscount, undefined);

        const withCap = validateCreateOfferDto(percentage({ discountType: 'flat-price', discountValue: 50, maxDiscount: 999 }));
        assert.equal(withCap.maxDiscount, undefined, 'a flat discount has nothing to cap');
    });
});

describe('every coupon', () => {
    it('needs a code', () => {
        assert.throws(() => validateCreateOfferDto(percentage({ couponCode: '' })), /Coupon code is required/i);
    });

    it('rejects a negative spend threshold', () => {
        assert.throws(() => validateCreateOfferDto(percentage({ minOrderValue: -1 })));
    });
});
