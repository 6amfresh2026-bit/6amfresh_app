import mongoose from 'mongoose';

/**
 * A customer's request for a product the catalog does not carry yet.
 *
 * The customer submits what they are looking for; the admin sees the list in
 * the Product Requests screen and works it (reviews, approves for sourcing, or
 * rejects). Status moves one way through review, so the admin can tell new
 * asks apart from ones already handled.
 */
const productRequestSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodUser', required: true, index: true },
        productName: { type: String, required: true, trim: true },
        brand: { type: String, default: '', trim: true },
        category: { type: String, default: '', trim: true },
        quantity: { type: String, default: '', trim: true },
        note: { type: String, default: '', trim: true },
        // Snapshot of who asked, so the admin list reads without a populate and
        // still shows something if the account is later removed.
        customerName: { type: String, default: '', trim: true },
        customerPhone: { type: String, default: '', trim: true },
        status: {
            type: String,
            enum: ['pending', 'reviewed', 'approved', 'rejected', 'fulfilled'],
            default: 'pending',
            index: true,
        },
        adminResponse: { type: String, default: '', trim: true },
    },
    { collection: 'food_product_requests', timestamps: true }
);

productRequestSchema.index({ userId: 1, createdAt: -1 });

export const FoodProductRequest = mongoose.model('FoodProductRequest', productRequestSchema);
