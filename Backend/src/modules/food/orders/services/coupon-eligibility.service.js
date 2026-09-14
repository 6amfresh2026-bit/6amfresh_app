import mongoose from 'mongoose';

import { FoodOrder } from '../models/order.model.js';
import { FoodOfferUsage } from '../../admin/models/offerUsage.model.js';

/**
 * Whether a coupon may be applied to a bill, and if not, why.
 *
 * This exists because two callers need the same answer and must never disagree:
 * the pricing engine, which decides what the order is actually charged, and the
 * till's coupon list, which shows the cashier what they can offer. A second
 * implementation of these rules would drift within a release, and the drift
 * shows up as a list that says "Apply" over a quote that then refuses.
 *
 * The evaluation is deliberately synchronous. Judging a list of coupons one at
 * a time would be two database round trips per coupon; instead the caller
 * resolves the customer's facts once with loadCouponCustomerFacts() and passes
 * them in, so twenty coupons cost the same two queries as one.
 */

const round0 = (n) => Math.max(0, Math.floor(Number(n) || 0));

/**
 * The rupees a coupon takes off, given the goods it applies to.
 *
 * Floored, not rounded, and never more than the bill: a coupon may reduce a
 * bill to zero but must never make it negative, which would push the tax base
 * below zero further down.
 */
/** What one rung, or a single-mode coupon, is worth on a given basket. */
const flatOrPercentOff = (rule, goods) => {
    if (rule?.discountType === 'percentage') {
        const raw = (goods * (Number(rule.discountValue) || 0)) / 100;
        const capped = Number(rule.maxDiscount) ? Math.min(raw, Number(rule.maxDiscount)) : raw;
        return Math.min(goods, round0(capped));
    }
    return Math.min(goods, round0(rule?.discountValue));
};

/**
 * A slab coupon's rungs, lowest threshold first.
 *
 * Sorted here as well as on write, because a document saved before that
 * sorting existed — or edited straight in the database — must not change what
 * a customer is charged.
 */
export function slabsOf(offer) {
    if (offer?.discountMode !== 'slab' || !Array.isArray(offer?.slabs)) return [];
    return offer.slabs
        .filter((s) => s && Number.isFinite(Number(s.minOrderValue)))
        .slice()
        .sort((a, b) => Number(a.minOrderValue) - Number(b.minOrderValue));
}

/** The lowest spend that gets the customer anything at all. */
export function couponEntryThreshold(offer) {
    const slabs = slabsOf(offer);
    if (slabs.length === 0) return Number(offer?.minOrderValue) || 0;
    return Number(slabs[0].minOrderValue) || 0;
}

/**
 * The rupees a coupon takes off, given the goods it applies to.
 *
 * Floored, not rounded, and never more than the bill: a coupon may reduce a
 * bill to zero but must never make it negative, which would push the tax base
 * below zero further down.
 *
 * On a slab coupon the customer gets the **best** rung they have reached, not
 * simply the highest. Those are the same thing for a sanely written campaign,
 * and they differ only when someone configures a higher slab that pays less —
 * a mistake the customer should not be charged for. It also makes the result
 * independent of the order the rungs happen to be stored in.
 */
export function couponDiscountFor(offer, subtotal) {
    const goods = Math.max(0, Number(subtotal) || 0);

    const slabs = slabsOf(offer);
    if (slabs.length > 0) {
        let best = 0;
        for (const slab of slabs) {
            if (goods < (Number(slab.minOrderValue) || 0)) break; // sorted: nothing above qualifies either
            best = Math.max(best, flatOrPercentOff(slab, goods));
        }
        return best;
    }

    return flatOrPercentOff(offer, goods);
}

/**
 * The next rung up, and what reaching it would be worth — the whole point of a
 * slab campaign, and useless unless somebody is told about it.
 *
 * Returns null when the coupon has no slabs, the customer is already on the
 * top rung, or climbing would not actually pay better.
 */
export function nextSlabFor(offer, subtotal) {
    const goods = Math.max(0, Number(subtotal) || 0);
    const slabs = slabsOf(offer);
    if (slabs.length === 0) return null;

    const current = couponDiscountFor(offer, goods);
    for (const slab of slabs) {
        const threshold = Number(slab.minOrderValue) || 0;
        if (goods >= threshold) continue;
        // Worth what it pays *at its own threshold*: a percentage rung is worth
        // more on a bigger basket, and quoting that larger figure would promise
        // a saving the customer would not get by spending exactly the minimum.
        const worth = flatOrPercentOff(slab, threshold);
        if (worth <= current) continue;
        return { minOrderValue: threshold, spendMore: Math.ceil(threshold - goods), discount: worth };
    }
    return null;
}

/**
 * The end of an all-day expiry.
 *
 * An end date saved as midnight means "through that day", not "until the
 * moment it began" — treating it literally expires a coupon a day early, which
 * is the sort of thing a customer notices at a counter.
 */
const endOfOfferWindow = (endDate) => {
    if (!endDate) return null;
    const end = new Date(endDate);
    if (end.getHours() === 0 && end.getMinutes() === 0) end.setHours(23, 59, 59, 999);
    return end;
};

const restaurantIdsOf = (offer) =>
    Array.isArray(offer?.restaurantIds) && offer.restaurantIds.length > 0
        ? offer.restaurantIds
        : [offer?.restaurantId].filter(Boolean);

/**
 * Everything about a customer the coupon rules depend on, in two queries.
 *
 * Pass null for an anonymous walk-in: the per-customer rules then cannot be
 * tested, and evaluateCoupon reports that rather than guessing either way.
 */
export async function loadCouponCustomerFacts(userId, offerIds = []) {
    if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) return null;
    const id = new mongoose.Types.ObjectId(String(userId));

    const [orderCount, usages] = await Promise.all([
        FoodOrder.countDocuments({ userId: id }),
        offerIds.length
            ? FoodOfferUsage.find({ userId: id, offerId: { $in: offerIds } }).select('offerId count').lean()
            : []
    ]);

    return {
        id: String(userId),
        orderCount,
        usedCountByOffer: new Map(usages.map((u) => [String(u.offerId), Number(u.count) || 0]))
    };
}

/**
 * Judges one coupon.
 *
 * Reasons are ordered by what a cashier can do about them: "add ₹120 more" is
 * worth saying before "this campaign is finished", because only one of them
 * ends with a sale.
 */
export function evaluateCoupon(offer, { subtotal = 0, restaurantId = '', now = new Date(), customer = null } = {}) {
    const refuse = (reason) => ({ eligible: false, reason, discount: 0 });
    if (!offer) return refuse('No such coupon');

    // Dates are judged before status on purpose. An expired campaign is also
    // flipped to inactive by the monthly sweep, and "Not active" tells the
    // cashier nothing they can repeat to the customer — "Expired" does.
    const end = endOfOfferWindow(offer.endDate);
    if (end && now > end) return refuse('Expired');
    if (offer.startDate && now < new Date(offer.startDate)) {
        return refuse(`Starts ${new Date(offer.startDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`);
    }

    if (offer.status === 'paused') return refuse('Paused by admin');
    if (offer.status !== 'active') return refuse('Not active');
    if (offer.showInCart === false) return refuse('Hidden by admin');

    if (offer.restaurantScope === 'selected') {
        const allowed = restaurantIdsOf(offer).some((id) => String(id) === String(restaurantId || ''));
        if (!allowed) return refuse('Not for this store');
    }

    const goods = Math.max(0, Number(subtotal) || 0);
    // On a slab coupon this is the bottom rung: the basket has to reach the
    // cheapest one before the coupon is worth anything at all.
    const minimum = couponEntryThreshold(offer);
    if (goods < minimum) return refuse(`Needs ₹${minimum} minimum — ₹${Math.ceil(minimum - goods)} more`);

    if (Number(offer.usageLimit) > 0 && Number(offer.usedCount || 0) >= Number(offer.usageLimit)) {
        return refuse('Fully used up');
    }

    const needsCustomer =
        Number(offer.perUserLimit) > 0 || offer.customerScope === 'first-time' || offer.isFirstOrderOnly === true;

    if (needsCustomer && !customer) {
        // An anonymous walk-in cannot be tested against a per-customer rule, and
        // the pricing engine will refuse it for the same reason. Saying so beats
        // offering it and having the sale bounce.
        return refuse('Pick a customer to use this');
    }

    if (customer) {
        if (Number(offer.perUserLimit) > 0) {
            const used = customer.usedCountByOffer.get(String(offer._id)) || 0;
            if (used >= Number(offer.perUserLimit)) return refuse('This customer has used it');
        }
        if ((offer.customerScope === 'first-time' || offer.isFirstOrderOnly === true) && customer.orderCount > 0) {
            return refuse('First-time customers only');
        }
    }

    const discount = couponDiscountFor(offer, goods);
    if (discount <= 0) return refuse('Works out to no discount on this bill');

    // Carried on an *eligible* verdict, not a refusal: the customer already has
    // a discount, and this says what one more rung would be worth.
    return { eligible: true, reason: '', discount, nextSlab: nextSlabFor(offer, goods) };
}

/** "20% off above ₹300" — one rung, as a campaign would print it. */
const describeSlab = (slab) => {
    const from = ` above ₹${Number(slab?.minOrderValue) || 0}`;
    if (slab?.discountType === 'percentage') {
        const cap = Number(slab.maxDiscount) ? `, up to ₹${Number(slab.maxDiscount)}` : '';
        return `${Number(slab.discountValue) || 0}% off${cap}${from}`;
    }
    return `₹${Number(slab?.discountValue) || 0} off${from}`;
};

/** "20% off, up to ₹100" / "₹50 off above ₹300, ₹120 off above ₹600" — what the cashier reads out. */
export function describeCoupon(offer) {
    if (!offer) return '';

    const slabs = slabsOf(offer);
    if (slabs.length > 0) return slabs.map(describeSlab).join(', ');

    if (offer.discountType === 'percentage') {
        const cap = Number(offer.maxDiscount) ? `, up to ₹${Number(offer.maxDiscount)}` : '';
        return `${Number(offer.discountValue) || 0}% off${cap}`;
    }
    return `₹${Number(offer.discountValue) || 0} off`;
}

/** Whether a coupon's eligibility depends on who the customer is. */
export function isCustomerScoped(offer) {
    return (
        Number(offer?.perUserLimit) > 0 ||
        offer?.customerScope === 'first-time' ||
        offer?.isFirstOrderOnly === true
    );
}
