import mongoose from 'mongoose';

/**
 * One intake of one product: what arrived, when it expires, how much is left.
 *
 * `stockQty` on the product says *how many* there are and remains the thing
 * that decides whether a sale can happen — that single atomic decrement is
 * what stops two customers buying the last unit, and batches deliberately do
 * not take that job over. Batches say *which* units: when they came in, what
 * they cost, and when they go off.
 *
 * Without them a product had one `expiryDate` for every unit ever received,
 * which is wrong the moment a second delivery arrives. Milk bought on Monday
 * and milk bought on Thursday are not interchangeable, and picking the wrong
 * one is the kind of mistake a refund does not undo.
 *
 * Only products with `manageMultipleBatch` carry them. Everything else keeps
 * behaving exactly as it did — which is every product that exists today.
 */
const stockBatchSchema = new mongoose.Schema(
    {
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodItem', required: true, index: true },
        restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant', required: true, index: true },
        /** What the supplier's carton says. Not unique — two suppliers reuse numbers. */
        batchNo: { type: String, trim: true, default: '' },
        /**
         * Null means "does not expire" and sorts last, so a dated batch is
         * always picked before an undated one.
         */
        expiryDate: { type: Date, default: null, index: true },
        receivedAt: { type: Date, default: Date.now, index: true },
        receivedQty: { type: Number, required: true, min: 0 },
        /** What is still on the shelf from this intake. */
        remainingQty: { type: Number, required: true, min: 0, index: true },
        /** Cost of this intake, which moves between deliveries. */
        purchasePrice: { type: Number, default: null, min: 0 },
        /**
         * 'written_off' is a batch removed from sale — expired, damaged. Its
         * remainingQty goes to zero and the units leave `stockQty` with it, so
         * expired stock cannot be sold by either route.
         */
        status: {
            type: String,
            enum: ['active', 'written_off'],
            default: 'active',
            index: true
        },
        writtenOffAt: { type: Date, default: null },
        writtenOffReason: { type: String, trim: true, default: '' }
    },
    { collection: 'food_stock_batches', timestamps: true }
);

/**
 * The picking order: soonest expiry first, and among equals the oldest intake.
 *
 * This is FEFO rather than FIFO on purpose. What arrived first is not always
 * what goes off first — a short-dated delivery can arrive after a long-dated
 * one, and picking by arrival would leave the short-dated stock to rot.
 */
stockBatchSchema.index({ itemId: 1, status: 1, expiryDate: 1, receivedAt: 1 });

export const FoodStockBatch = mongoose.model('FoodStockBatch', stockBatchSchema);
