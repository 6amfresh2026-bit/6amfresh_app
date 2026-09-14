import mongoose from 'mongoose';

/**
 * One rung of a spend-slab coupon: "from ₹300, take ₹50 off".
 *
 * Each rung carries its own kind of discount so a campaign can pay a flat
 * amount at the bottom and a capped percentage higher up, which is how these
 * are actually written — a flat ₹50 is legible on a small basket, and a
 * percentage is what makes a large one worth chasing.
 */
const offerSlabSchema = new mongoose.Schema(
    {
        minOrderValue: { type: Number, required: true, min: 0 },
        discountType: { type: String, enum: ['percentage', 'flat-price'], default: 'flat-price' },
        discountValue: { type: Number, required: true, min: 0 },
        maxDiscount: { type: Number, default: null, min: 0 }
    },
    { _id: false }
);

const foodOfferSchema = new mongoose.Schema(
    {
        couponCode: { type: String, required: true, trim: true, uppercase: true, unique: true },
        discountType: { type: String, enum: ['percentage', 'flat-price'], default: 'percentage', index: true },
        discountValue: { type: Number, required: true, min: 0 },
        /**
         * 'single' is one threshold and one discount — every coupon that
         * existed before this field, which is why it is the default.
         *
         * 'slab' reads `slabs` instead: the customer gets the best rung they
         * have reached. Admin-only; a store cannot create one, because the
         * platform is what funds the larger baskets these are meant to buy.
         */
        discountMode: { type: String, enum: ['single', 'slab'], default: 'single', index: true },
        /**
         * Kept sorted by minOrderValue ascending on write so every reader sees
         * the rungs in the order a customer climbs them.
         */
        slabs: { type: [offerSlabSchema], default: [] },
        customerScope: { type: String, enum: ['all', 'first-time'], default: 'all', index: true },
        restaurantScope: { type: String, enum: ['all', 'selected'], default: 'all', index: true },
        restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant' },
        restaurantIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant' }],
        minOrderValue: { type: Number, default: 0, min: 0 },
        maxDiscount: { type: Number, default: null, min: 0 },
        usageLimit: { type: Number, default: null, min: 0 },
        perUserLimit: { type: Number, default: null, min: 0 },
        usedCount: { type: Number, default: 0, min: 0 },
        startDate: { type: Date },
        isFirstOrderOnly: { type: Boolean, default: false },
        endDate: { type: Date },
        status: { type: String, enum: ['active', 'paused', 'inactive'], default: 'active', index: true },
        showInCart: { type: Boolean, default: true },
        createdByRole: { type: String, enum: ['ADMIN', 'RESTAURANT'], default: 'ADMIN', index: true },
        adminBearPercentage: { type: Number, default: 100, min: 0, max: 100 },
        restaurantBearPercentage: { type: Number, default: 0, min: 0, max: 100 },
        // Auto-renewing monthly offer: rolled forward to the next calendar month
        // by renewMonthlyOffers() instead of just expiring (see admin.service.js).
        isMonthly: { type: Boolean, default: false, index: true },
        // How many days before the next calendar month starts to notify customers.
        notifyDaysBeforeNextMonth: { type: Number, default: 23, min: 0, max: 60 },
        // 'YYYY-MM' of the month last notified for, so notifyUpcomingMonthlyOffers()
        // doesn't re-notify every time it runs within the same notification window.
        lastNotifiedForMonth: { type: String, default: null }
    },
    { collection: 'food_offers', timestamps: true }
);

foodOfferSchema.index({ restaurantId: 1, createdAt: -1 });
foodOfferSchema.index({ restaurantIds: 1, createdAt: -1 });

export const FoodOffer = mongoose.model('FoodOffer', foodOfferSchema);
