import mongoose from 'mongoose';

/**
 * A till session ("register") a cashier opens with a starting float and closes
 * by counting the drawer. Everything rung up while it is open rolls into it, so
 * the close screen can show expected vs counted cash and the difference.
 *
 * One register is open per store at a time — enforced in pos.service.js.
 */
const posShiftSchema = new mongoose.Schema(
    {
        restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant', required: true, index: true },
        // Human-readable, per store per day: "SH1-20261016-01".
        shiftCode: { type: String, required: true },
        cashierName: { type: String, default: '', trim: true },
        openingCash: { type: Number, default: 0, min: 0 },

        // Manual cash movements during the shift (pay-in / pay-out / refunds).
        cashReceived: { type: Number, default: 0, min: 0 },
        cashOut: { type: Number, default: 0, min: 0 },
        refunds: { type: Number, default: 0, min: 0 },

        status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
        openedAt: { type: Date, default: Date.now },
        closedAt: { type: Date, default: null },

        // Snapshot taken at close.
        cashSales: { type: Number, default: null },
        billsCount: { type: Number, default: null },
        expectedCash: { type: Number, default: null },
        countedCash: { type: Number, default: null },
        // { "500": 3, "200": 1, ... } — what the cashier counted.
        denominations: { type: mongoose.Schema.Types.Mixed, default: null },
        // countedCash - expectedCash (negative = short, positive = over).
        difference: { type: Number, default: null }
    },
    { collection: 'food_pos_shifts', timestamps: true }
);

posShiftSchema.index({ restaurantId: 1, status: 1 });

export const FoodPosShift = mongoose.model('FoodPosShift', posShiftSchema);
