/**
 * Loyalty programme rules.
 *
 * Kept as one small, named default so every earn and redeem across the till
 * reads the same numbers. These are deliberately simple and store-agnostic for
 * now; when an admin screen to tune them per store lands, this is the one place
 * a lookup would replace the constant.
 *
 *  - earn:   1 point for every ₹100 of bill value (floored)
 *  - redeem: 1 point is worth ₹1 off a later bill
 *  - a redemption needs at least `minRedeemPoints` and can cover at most
 *    `maxRedeemBillFraction` of the bill, so points never settle a whole sale.
 */
export const LOYALTY = {
    earnPerRupee: 0.01, // ₹100 → 1 point
    redeemRupeePerPoint: 1, // 1 point → ₹1
    minRedeemPoints: 50,
    maxRedeemBillFraction: 0.5,
};

/** Points a bill of this value earns. */
export const pointsEarnedFor = (billTotal) => Math.max(0, Math.floor((Number(billTotal) || 0) * LOYALTY.earnPerRupee));

/** Rupee value of a number of points when redeemed. */
export const rupeeValueOf = (points) => Math.max(0, Math.round((Number(points) || 0) * LOYALTY.redeemRupeePerPoint));

/** Points needed to redeem a rupee amount (inverse of rupeeValueOf). */
export const pointsForRupees = (rupees) => Math.max(0, Math.round((Number(rupees) || 0) / LOYALTY.redeemRupeePerPoint));
