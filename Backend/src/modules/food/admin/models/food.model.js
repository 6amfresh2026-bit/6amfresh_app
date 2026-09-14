import mongoose from 'mongoose';

const foodVariantSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        price: { type: Number, required: true, min: 0 },
        otherPrice: { type: Number, min: 0, default: 0 }
    },
    { _id: true }
);

const foodSchema = new mongoose.Schema(
    {
        restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant', required: true, index: true },
        categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodCategory', index: true },
        categoryName: { type: String, trim: true, default: '' },
        name: { type: String, required: true, trim: true, index: true },
        description: { type: String, trim: true, default: '' },
        price: { type: Number, required: true, min: 0 },
        /** Compare-at / other-platform price for strikethrough UI. Existing items stay 0. */
        otherPrice: { type: Number, min: 0, default: 0 },
        variants: { type: [foodVariantSchema], default: [] },
        /**
         * The dish's primary image, kept as the first entry of [images].
         *
         * Retained as its own field rather than being derived: every existing
         * document has it, and the user app, admin list, share previews and push
         * payloads all read it. Dropping it would have meant a migration plus a
         * change in four consumers to gain nothing.
         */
        image: { type: String, trim: true, default: '' },

        /**
         * All images for the dish, primary first.
         *
         * Empty on existing documents, which is why every read falls back to
         * `image` rather than assuming this is populated.
         */
        images: { type: [String], default: [] },
        foodType: { type: String, enum: ['Veg', 'Non-Veg'], default: 'Non-Veg' },
        /** Manufacturer, for the grocery listing where two sellers stock the same product. */
        brand: { type: String, trim: true, default: '' },
        /** What one unit is: "500 g", "1 L", "pack of 6". Free text, since packs are not standard. */
        packSize: { type: String, trim: true, default: '' },
        /**
         * The seller's own stock-keeping code.
         *
         * Indexed but deliberately not unique: sellers pick their own codes and
         * two of them will collide, so uniqueness could only ever be per-seller,
         * and enforcing it globally would reject a legitimate second seller.
         */
        sku: { type: String, trim: true, default: '', index: true },
        /**
         * Scanned barcode (EAN/UPC). Distinct from `sku`: a barcode identifies
         * the manufactured product, an SKU identifies the seller's shelf entry,
         * and searching by one must not silently match the other.
         */
        barcode: { type: String, trim: true, default: '', index: true },
        /**
         * Batch expiry. Null means non-perishable or simply not tracked — the
         * two are indistinguishable here and both mean "never flag this".
         *
         * Date, not string, so a range query can find what expires this week.
         */
        expiryDate: { type: Date, default: null, index: true },
        /**
         * Printed maximum retail price, shown struck through next to `price`.
         *
         * Kept separate from `otherPrice`, which is a compare-at price against
         * other platforms. Selling above MRP is illegal, so this one is a
         * constraint, not a marketing number, and conflating them would make
         * that check impossible to write.
         */
        mrp: { type: Number, min: 0, default: null },
        /**
         * GST percentage for this product. Groceries span 0/5/12/18, so the
         * single order-wide rate the food flow used is wrong here.
         *
         * `null` falls back to the order-wide rate in fee settings, which is
         * what every item created before this field existed does.
         */
        gstRate: { type: Number, min: 0, max: 100, default: null },
        isAvailable: { type: Boolean, default: true, index: true },
        /**
         * Units on hand. `null` means untracked — the item behaves exactly as it
         * did before inventory existed, which is what every already-created
         * document gets, so nothing needs a migration to keep selling.
         *
         * Tracked at item level, not per variant: a variant is a pack size, and
         * a seller counting "12 left" is counting the item.
         * ponytail: per-variant stock if sellers start listing sizes that
         * genuinely deplete independently.
         */
        stockQty: { type: Number, default: null, min: 0 },
        /**
         * Units held back for quality testing / samples: on the shelf, but not
         * sellable. Reported beside the available quantity, never deducted by an
         * order, so the two numbers stay independent.
         */
        testingQty: { type: Number, default: 0, min: 0 },
        /** Below this, the item is flagged to the seller. `null` disables the flag. */
        lowStockThreshold: { type: Number, default: null, min: 0 },
        /** Cap per single order, so one buyer cannot clear the shelf. `null` = uncapped. */
        maxQtyPerOrder: { type: Number, default: null, min: 1 },
        /**
         * What the picker may put in the bag when this runs out.
         *
         * Nominated per product rather than inferred from the category: the
         * customer who ordered lactose-free milk did not order milk, and a
         * category is nowhere near a good enough guess to spend their money
         * on. Empty means no substitution — refund the line instead.
         */
        substituteItemIds: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FoodItem' }],
            default: []
        },
        /** Running average of per-dish ratings left by customers. */
        rating: { type: Number, default: 0, min: 0, max: 5 },
        totalRatings: { type: Number, default: 0, min: 0 },
        /** When set, item auto-restores to available after this time (server-side). */
        stockResumeAt: { type: Date, index: true },
        stockOffMode: {
            type: String,
            enum: ['manual', 'specific-time', 'next-business-day', 'custom-date-time'],
            default: undefined
        },
        // ───────────── ERP product master (vasy-style "Create New") ─────────────
        // Every field below is optional with a null/empty default, so the documents
        // that exist today keep validating and keep selling untouched.

        /**
         * Human-facing product code, "PRD0000081760". Generated from a counter at
         * create time unless the admin types one. Sparse-unique so the existing
         * catalogue, which has none, does not collide on the empty value.
         */
        itemCode: { type: String, trim: true, index: true, unique: true, sparse: true },
        productType: {
            type: String,
            enum: ['Finished', 'Raw Material', 'Semi Finished', 'Service', 'Consumable'],
            default: 'Finished'
        },
        /** Name as it appears on the bill / label when the full name is too long. */
        printName: { type: String, trim: true, default: '' },
        subCategoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodCategory', index: true, default: null },
        departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodDepartment', index: true, default: null },
        /** Structured brand. `brand` (free text) stays as the display fallback until migrated. */
        brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodBrand', index: true, default: null },
        subBrandId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodBrand', default: null },
        /** Primary unit of measurement. */
        unitId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodUnit', default: null },
        /** Up to two more selling units (three total, the "Max. 3 Units" rule). */
        additionalUnitIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FoodUnit' }], default: [] },
        hsnCode: { type: String, trim: true, default: '' },
        purchaseTaxRate: { type: Number, min: 0, max: 100, default: null },
        purchaseTaxInclusive: { type: Boolean, default: false },
        /** Sales tax rate is the existing `gstRate`; this flag says whether `price` already includes it. */
        salesTaxInclusive: { type: Boolean, default: false },
        cessEnabled: { type: Boolean, default: false },
        cessRate: { type: Number, min: 0, max: 100, default: null },
        /** When on, stock is kept per batch (Phase 4). Stored now so the form round-trips. */
        manageMultipleBatch: { type: Boolean, default: false },
        shortDescription: { type: String, trim: true, default: '' },
        nutrition: {
            type: [{ name: { type: String, trim: true }, value: { type: String, trim: true }, unit: { type: String, trim: true } }],
            default: []
        },
        netWeight: { type: Number, min: 0, default: null },
        netWeightUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodUnit', default: null },
        additionalInfo: { type: String, trim: true, default: '' },

        // Pricing tiers. `price` remains the selling price and `mrp` the MRP.
        purchasePrice: { type: Number, min: 0, default: null },
        landingCost: { type: Number, min: 0, default: null },
        sellingDiscount: { type: Number, min: 0, default: null },
        sellingMargin: { type: Number, default: null },
        retailerDiscount: { type: Number, min: 0, default: null },
        retailerPrice: { type: Number, min: 0, default: null },
        retailerMargin: { type: Number, default: null },
        wholesalerDiscount: { type: Number, min: 0, default: null },
        wholesalerPrice: { type: Number, min: 0, default: null },
        wholesalerMargin: { type: Number, default: null },
        onlinePrice: { type: Number, min: 0, default: null },
        minimumQuantity: { type: Number, min: 0, default: null },

        /** The "Show Online" toggle on the product list. */
        showOnline: { type: Boolean, default: false, index: true },
        /** Soft delete — rows go to "Deleted Products" and can be restored. */
        isDeleted: { type: Boolean, default: false, index: true },
        deletedAt: { type: Date, default: null },
        // ──────────────────────────────────────────────────────────────────────

        isRecommended: { type: Boolean, default: false, index: true },
        /** Seller/admin opt-in gate for recurring "Product Subscriptions" (see productSubscription.model.js) — a customer can only subscribe to an item once this is true. */
        subscriptionEnabled: { type: Boolean, default: false, index: true },
        preparationTime: { type: String, trim: true, default: '' },
        approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved', index: true },
        rejectionReason: { type: String, trim: true, default: '' },
        requestedAt: { type: Date },
        approvedAt: { type: Date },
        rejectedAt: { type: Date }
    },
    {
        collection: 'food_items',
        timestamps: true
    }
);

foodSchema.index({ restaurantId: 1, createdAt: -1 });
foodSchema.index({ approvalStatus: 1, createdAt: -1 });
foodSchema.index({ approvalStatus: 1, requestedAt: -1 });
foodSchema.index({ restaurantId: 1, approvalStatus: 1, createdAt: -1 });

export const FoodItem = mongoose.model('FoodItem', foodSchema);
