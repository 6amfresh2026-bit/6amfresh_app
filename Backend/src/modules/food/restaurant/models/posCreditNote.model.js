import mongoose from 'mongoose';

/**
 * A credit note: store money owed back to a customer that is redeemable against
 * a later bill instead of being handed over as cash.
 *
 * Issued when goods come back (a return) — the counter records the amount and a
 * reason, and the customer walks away with a code (CN-YYYYMMDD-NN). On a future
 * sale the cashier enters that code as a tender; the balance drops by what was
 * applied and the note closes when it reaches zero.
 *
 * Scoped to the issuing store: a note is only ever redeemable where it was
 * given, so one shop's goodwill is never spent at another's till.
 */
const redemptionSchema = new mongoose.Schema(
    {
        orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodOrder', default: null },
        billNo: { type: String, default: '', trim: true },
        amount: { type: Number, required: true, min: 0 },
        at: { type: Date, default: Date.now }
    },
    { _id: false }
);

const posCreditNoteSchema = new mongoose.Schema(
    {
        restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant', required: true, index: true },
        // Human-readable, per store per day: "CN-20261019-01".
        code: { type: String, required: true, uppercase: true, trim: true },

        customerPhone: { type: String, default: '', trim: true },
        customerName: { type: String, default: '', trim: true },

        // What the note was worth when issued, and what is left to spend.
        amount: { type: Number, required: true, min: 0 },
        balance: { type: Number, required: true, min: 0 },

        reason: { type: String, default: '', trim: true },
        // The sale the return came off, when there is one.
        sourceOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodOrder', default: null },
        sourceBillNo: { type: String, default: '', trim: true },

        status: {
            type: String,
            enum: ['active', 'partially_redeemed', 'redeemed', 'void'],
            default: 'active',
            index: true
        },
        redemptions: { type: [redemptionSchema], default: [] },

        issuedBy: { type: String, default: '', trim: true },
        voidedAt: { type: Date, default: null }
    },
    { collection: 'food_pos_credit_notes', timestamps: true }
);

// A code is unique within a store; the same string may recur across stores.
posCreditNoteSchema.index({ restaurantId: 1, code: 1 }, { unique: true });
posCreditNoteSchema.index({ restaurantId: 1, status: 1 });

export const FoodPosCreditNote = mongoose.model('FoodPosCreditNote', posCreditNoteSchema);
