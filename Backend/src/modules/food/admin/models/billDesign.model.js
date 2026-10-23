import mongoose from 'mongoose';

/**
 * A saved POS receipt design.
 *
 * One document per store, plus one with `restaurantId: null` that is the
 * all-stores default a store falls back to when it has not set its own. The
 * whole layout is kept as a free `config` blob rather than a column per toggle:
 * the designer owns the shape, the POS reads it back whole, and neither should
 * need a migration every time a new line is added to the receipt.
 */
const billDesignSchema = new mongoose.Schema(
    {
        restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant', default: null },
        config: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    { collection: 'food_bill_designs', timestamps: true }
);

billDesignSchema.index({ restaurantId: 1 }, { unique: true });

export const BillDesign = mongoose.model('BillDesign', billDesignSchema);
