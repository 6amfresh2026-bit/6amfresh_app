import mongoose from 'mongoose';

/**
 * A customer's loyalty balance at one store.
 *
 * Points are earned on counter sales (opt-in per bill) and redeemed against a
 * later bill as a tender. Scoped per store, like credit notes, so points given
 * at one shop aren't quietly spent at another. Every change is appended to the
 * ledger, so the balance is always explainable — a reward scheme nobody can
 * audit is a reward scheme nobody trusts.
 */
const loyaltyLedgerSchema = new mongoose.Schema(
    {
        type: { type: String, enum: ['earn', 'redeem', 'adjust'], required: true },
        // Positive on earn/credit, negative on redeem.
        points: { type: Number, required: true },
        orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodOrder', default: null },
        billNo: { type: String, default: '', trim: true },
        note: { type: String, default: '', trim: true },
        at: { type: Date, default: Date.now }
    },
    { _id: false }
);

const posLoyaltyAccountSchema = new mongoose.Schema(
    {
        restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant', required: true, index: true },
        customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodUser', required: true, index: true },
        balance: { type: Number, default: 0, min: 0 },
        ledger: { type: [loyaltyLedgerSchema], default: [] }
    },
    { collection: 'food_pos_loyalty_accounts', timestamps: true }
);

posLoyaltyAccountSchema.index({ restaurantId: 1, customerId: 1 }, { unique: true });

export const FoodPosLoyaltyAccount = mongoose.model('FoodPosLoyaltyAccount', posLoyaltyAccountSchema);
