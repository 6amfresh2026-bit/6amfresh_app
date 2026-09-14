import mongoose from 'mongoose';

const deliveryFeeRangeSchema = new mongoose.Schema(
    {
        min: { type: Number, required: true, min: 0 },
        max: { type: Number, required: true, min: 0 },
        fee: { type: Number, required: true, min: 0 },
        deliveryBoyPerKm: { type: Number, min: 0, default: 0 },
        deliveryBoyBasePay: { type: Number, min: 0, default: 0 }
    },
    { _id: false }
);

const feeSettingsSchema = new mongoose.Schema(
    {
        // No defaults here; admin must explicitly configure values.
        deliveryFee: { type: Number, min: 0 },
        deliveryFeeRanges: { type: [deliveryFeeRangeSchema], default: [] },
        platformFee: { type: Number, min: 0 },
        quickDeliveryFee: { type: Number, min: 0 },
        /**
         * A basket below this is charged `smallCartFee`.
         *
         * A rider rides the same distance for a Rs.30 order as a Rs.400 one,
         * so the small one was delivered at a guaranteed loss — there was no
         * floor of any kind anywhere in the system. A surcharge rather than a
         * hard minimum on purpose: refusing the order loses the customer,
         * charging for the trip only prices it.
         *
         * Zero or unset means no surcharge, which is what every existing
         * installation gets until an admin decides otherwise.
         */
        smallCartThreshold: { type: Number, min: 0, default: 0 },
        smallCartFee: { type: Number, min: 0, default: 0 },
        /**
         * At or above this basket the delivery fee is waived. Zero or unset
         * means never — the fee always applies, as it did before.
         */
        freeDeliveryAbove: { type: Number, min: 0, default: 0 },
        gstRate: { type: Number, min: 0, max: 100 },
        isActive: { type: Boolean, default: true, index: true }
    },
    { collection: 'food_fee_settings', timestamps: true }
);

feeSettingsSchema.index({ isActive: 1, createdAt: -1 });

export const FoodFeeSettings = mongoose.model('FoodFeeSettings', feeSettingsSchema);

