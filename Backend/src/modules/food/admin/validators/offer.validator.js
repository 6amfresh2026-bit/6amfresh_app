import { z } from 'zod';
import mongoose from 'mongoose';
import { ValidationError } from '../../../../core/auth/errors.js';

const offerSlabSchema = z.object({
    minOrderValue: z.number().min(0, 'Slab spend cannot be negative'),
    discountType: z.enum(['percentage', 'flat-price']).default('flat-price'),
    discountValue: z.number().positive('Every slab needs a discount greater than 0'),
    maxDiscount: z.number().min(0).nullable().optional()
});

const createOfferSchema = z.object({
    couponCode: z.string().min(1, 'Coupon code is required'),
    discountType: z.enum(['percentage', 'flat-price']).default('percentage'),
    discountValue: z.number().positive('Discount value must be greater than 0'),
    discountMode: z.enum(['single', 'slab']).default('single'),
    slabs: z.array(offerSlabSchema).optional(),
    customerScope: z.enum(['all', 'first-time']).default('all'),
    restaurantScope: z.enum(['all', 'selected']).default('all'),
    restaurantId: z.string().optional(),
    restaurantIds: z.array(z.string()).optional(),
    endDate: z.string().optional().or(z.literal('')).or(z.undefined()),
    startDate: z.string().optional().or(z.literal('')).or(z.undefined()),
    minOrderValue: z.number().min(0).optional(),
    maxDiscount: z.number().min(0).optional(),
    usageLimit: z.number().min(0).optional(),
    perUserLimit: z.number().min(0).optional(),
    isFirstOrderOnly: z.boolean().optional(),
    adminBearPercentage: z.number().min(0).max(100).optional(),
    restaurantBearPercentage: z.number().min(0).max(100).optional(),
    isMonthly: z.boolean().optional(),
    notifyDaysBeforeNextMonth: z.number().min(0).max(60).optional()
});

/** A slab as it arrives from the form: every figure a string until proven otherwise. */
const normalizeSlab = (raw) => ({
    minOrderValue: Number(raw?.minOrderValue),
    discountType: raw?.discountType === 'percentage' ? 'percentage' : 'flat-price',
    discountValue: Number(raw?.discountValue),
    maxDiscount:
        raw?.maxDiscount === undefined || raw?.maxDiscount === null || raw?.maxDiscount === ''
            ? null
            : Number(raw.maxDiscount)
});

export const validateCreateOfferDto = (body) => {
    const isSlabMode = body?.discountMode === 'slab';
    // Sorted the moment they arrive, so "the bottom rung" means the same thing
    // to every line below regardless of the order the form sent them in.
    const rawSlabs =
        isSlabMode && Array.isArray(body?.slabs)
            ? body.slabs.map(normalizeSlab).sort((a, b) => a.minOrderValue - b.minOrderValue)
            : undefined;

    const normalized = {
        ...body,
        couponCode: typeof body?.couponCode === 'string' ? body.couponCode.trim() : body?.couponCode,
        discountMode: isSlabMode ? 'slab' : 'single',
        slabs: rawSlabs,
        // In slab mode the top-level discount is a mirror of the bottom rung,
        // filled in below — but the schema requires it, so give it something
        // parseable rather than NaN from an empty form field.
        discountType: isSlabMode ? (rawSlabs?.[0]?.discountType ?? 'flat-price') : body?.discountType,
        discountValue: isSlabMode ? (rawSlabs?.[0]?.discountValue ?? 1) : Number(body?.discountValue),
        customerScope: body?.customerScope,
        restaurantScope: body?.restaurantScope,
        restaurantId: body?.restaurantId ? String(body.restaurantId) : undefined,
        restaurantIds: Array.isArray(body?.restaurantIds)
            ? body.restaurantIds.map((id) => String(id)).filter(Boolean)
            : undefined,
        endDate: body?.endDate ? String(body.endDate) : undefined,
        startDate: body?.startDate ? String(body.startDate) : undefined,
        minOrderValue: body?.minOrderValue !== undefined ? Number(body.minOrderValue) : undefined,
        maxDiscount: body?.maxDiscount !== undefined ? Number(body.maxDiscount) : undefined,
        usageLimit: body?.usageLimit !== undefined ? Number(body.usageLimit) : undefined,
        perUserLimit: body?.perUserLimit !== undefined ? Number(body.perUserLimit) : undefined,
        isFirstOrderOnly: body?.isFirstOrderOnly !== undefined ? Boolean(body.isFirstOrderOnly) : undefined,
        adminBearPercentage: body?.adminBearPercentage !== undefined ? Number(body.adminBearPercentage) : undefined,
        restaurantBearPercentage: body?.restaurantBearPercentage !== undefined ? Number(body.restaurantBearPercentage) : undefined,
        isMonthly: body?.isMonthly !== undefined ? Boolean(body.isMonthly) : undefined,
        notifyDaysBeforeNextMonth: body?.notifyDaysBeforeNextMonth !== undefined ? Number(body.notifyDaysBeforeNextMonth) : undefined
    };

    const result = createOfferSchema.safeParse(normalized);
    if (!result.success) {
        throw new ValidationError(result.error.errors[0].message);
    }

    if (result.data.restaurantScope === 'selected') {
        const restaurantIds = [
            ...(result.data.restaurantIds || []),
            ...(result.data.restaurantId ? [result.data.restaurantId] : [])
        ];
        if (restaurantIds.length === 0 || restaurantIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
            throw new ValidationError('At least one valid store is required for selected store scope');
        }
    }

    let endDate = result.data.endDate ? new Date(`${result.data.endDate}T23:59:59.999Z`) : undefined;
    if (endDate && Number.isNaN(endDate.getTime())) {
        throw new ValidationError('Invalid endDate');
    }
    let startDate = result.data.startDate ? new Date(`${result.data.startDate}T00:00:00.000Z`) : undefined;
    if (startDate && Number.isNaN(startDate.getTime())) {
        throw new ValidationError('Invalid startDate');
    }

    // A monthly offer with no explicit window defaults to "the rest of the
    // current calendar month" — renewMonthlyOffers() rolls it forward from there.
    if (result.data.isMonthly && !startDate && !endDate) {
        const now = new Date();
        startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    if (endDate && startDate && endDate.getTime() <= startDate.getTime()) {
        throw new ValidationError('endDate must be after startDate');
    }
    if (endDate && endDate.getTime() <= Date.now()) {
        throw new ValidationError('endDate must be a future date');
    }
    // ── spend slabs ──────────────────────────────────────────────────────────
    // A slab coupon is judged rung by rung, then mirrored down onto the
    // single-mode fields so that anything still reading discountType /
    // discountValue / minOrderValue sees the bottom rung rather than nothing.
    const slabs = result.data.discountMode === 'slab' ? (result.data.slabs || []) : [];
    if (result.data.discountMode === 'slab') {
        if (slabs.length === 0) throw new ValidationError('A slab coupon needs at least one slab');

        const seen = new Set();
        for (const slab of slabs) {
            if (seen.has(slab.minOrderValue)) {
                throw new ValidationError(`Two slabs both start at ₹${slab.minOrderValue} — give each one its own spend`);
            }
            seen.add(slab.minOrderValue);

            if (slab.discountType === 'percentage') {
                if (slab.maxDiscount === null || slab.maxDiscount === undefined || Number.isNaN(slab.maxDiscount)) {
                    throw new ValidationError(`The ₹${slab.minOrderValue} slab is a percentage, so it needs a maximum discount`);
                }
            } else if (slab.discountValue > slab.minOrderValue && slab.minOrderValue > 0) {
                // ₹500 off a ₹300 basket is a free basket plus change; the
                // engine floors it at the bill, so the campaign would silently
                // mean something other than what was typed.
                throw new ValidationError(`₹${slab.discountValue} off a ₹${slab.minOrderValue} spend gives the order away — lower the discount`);
            }
        }
    }

    // Business rule: percentage coupon must have maxDiscount; flat ignores it
    let maxDiscount = result.data.maxDiscount;
    if (slabs.length > 0) {
        maxDiscount = slabs[0].maxDiscount ?? undefined;
    } else if (result.data.discountType === 'percentage') {
        if (maxDiscount === undefined || maxDiscount === null || Number.isNaN(Number(maxDiscount))) {
            throw new ValidationError('maxDiscount is required for percentage coupons');
        }
        maxDiscount = Math.max(0, Number(maxDiscount) || 0);
    } else {
        maxDiscount = undefined; // ignore for flat-price
    }

    const restaurantIds = result.data.restaurantScope === 'selected'
        ? [...new Set([
            ...(result.data.restaurantIds || []),
            ...(result.data.restaurantId ? [result.data.restaurantId] : [])
        ])]
        : [];
    const adminBearPercentage = result.data.adminBearPercentage ?? 100;
    const restaurantBearPercentage = result.data.restaurantBearPercentage ?? 0;
    if (Math.round((adminBearPercentage + restaurantBearPercentage) * 100) / 100 !== 100) {
        throw new ValidationError('Admin bear and store bear must total 100%');
    }

    return {
        couponCode: result.data.couponCode.trim().toUpperCase(),
        discountMode: result.data.discountMode,
        slabs,
        // Mirrored from the bottom rung in slab mode — see above.
        discountType: slabs.length > 0 ? slabs[0].discountType : result.data.discountType,
        discountValue: slabs.length > 0 ? slabs[0].discountValue : result.data.discountValue,
        customerScope: result.data.customerScope,
        restaurantScope: result.data.restaurantScope,
        restaurantId: restaurantIds[0],
        restaurantIds,
        endDate,
        startDate,
        minOrderValue: slabs.length > 0 ? slabs[0].minOrderValue : result.data.minOrderValue,
        maxDiscount,
        usageLimit: result.data.usageLimit,
        perUserLimit: result.data.perUserLimit,
        isFirstOrderOnly: result.data.isFirstOrderOnly,
        adminBearPercentage,
        restaurantBearPercentage,
        isMonthly: result.data.isMonthly ?? false,
        notifyDaysBeforeNextMonth: result.data.notifyDaysBeforeNextMonth ?? 23
    };
};

const cartVisibilitySchema = z.object({
    itemId: z.string().min(1, 'itemId is required'),
    showInCart: z.boolean()
});

export const validateUpdateOfferCartVisibilityDto = (body) => {
    const result = cartVisibilitySchema.safeParse(body || {});
    if (!result.success) {
        throw new ValidationError(result.error.errors[0].message);
    }
    return result.data;
};
