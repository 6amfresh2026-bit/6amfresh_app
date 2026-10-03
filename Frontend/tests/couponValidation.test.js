import { describe, it, expect } from 'vitest'
import { validateCouponForm } from '../src/modules/Food/pages/restaurant/couponValidation'

const TODAY = '2026-10-02'
const valid = (over = {}) => ({
  couponCode: 'SAVE10',
  discountType: 'percentage',
  discountValue: '10',
  maxDiscount: '50',
  startDate: '2026-10-02',
  endDate: '2026-12-31',
  isMonthly: false,
  ...over,
})

describe('validateCouponForm', () => {
  it('accepts a complete percentage coupon', () => {
    expect(validateCouponForm(valid(), TODAY)).toEqual({})
  })

  it('requires a cap on a percentage coupon, with a message a seller can read', () => {
    const e = validateCouponForm(valid({ maxDiscount: '' }), TODAY)
    expect(Object.keys(e)).toEqual(['maxDiscount'])
    expect(e.maxDiscount).toMatch(/maximum discount/i)
    expect(e.maxDiscount).not.toMatch(/maxDiscount is required/)
  })

  it('treats a zero or negative cap as missing', () => {
    expect(validateCouponForm(valid({ maxDiscount: '0' }), TODAY).maxDiscount).toBeTruthy()
    expect(validateCouponForm(valid({ maxDiscount: '-5' }), TODAY).maxDiscount).toBeTruthy()
  })

  it('does not ask for a cap on a flat discount', () => {
    expect(validateCouponForm(valid({ discountType: 'flat-price', maxDiscount: '' }), TODAY)).toEqual({})
  })

  it('refuses a percentage over 100', () => {
    expect(validateCouponForm(valid({ discountValue: '120' }), TODAY).discountValue).toMatch(/exceed 100/)
  })

  it('refuses a missing, non-numeric, or non-positive discount', () => {
    expect(validateCouponForm(valid({ discountValue: '' }), TODAY).discountValue).toBeTruthy()
    expect(validateCouponForm(valid({ discountValue: 'abc' }), TODAY).discountValue).toBeTruthy()
    expect(validateCouponForm(valid({ discountValue: '0' }), TODAY).discountValue).toBeTruthy()
  })

  it('needs a code, ignoring blanks', () => {
    expect(validateCouponForm(valid({ couponCode: '   ' }), TODAY).couponCode).toBeTruthy()
  })

  it('needs both dates unless the offer is monthly', () => {
    const e = validateCouponForm(valid({ startDate: '', endDate: '' }), TODAY)
    expect(e.startDate).toBeTruthy()
    expect(e.endDate).toBeTruthy()
    expect(validateCouponForm(valid({ startDate: '', endDate: '', isMonthly: true }), TODAY)).toEqual({})
  })

  it('refuses a start date in the past', () => {
    expect(validateCouponForm(valid({ startDate: '2026-10-01' }), TODAY).startDate).toMatch(/past/)
  })

  it('refuses an end date before the start', () => {
    expect(validateCouponForm(valid({ startDate: '2026-11-01', endDate: '2026-10-15' }), TODAY).endDate).toMatch(/after start/)
  })

  it('reports every problem at once, so the seller fixes the form in one pass', () => {
    const e = validateCouponForm(
      { couponCode: '', discountType: 'percentage', discountValue: '', maxDiscount: '', startDate: '', endDate: '' },
      TODAY,
    )
    expect(Object.keys(e).sort()).toEqual(['couponCode', 'discountValue', 'endDate', 'maxDiscount', 'startDate'])
  })
})
