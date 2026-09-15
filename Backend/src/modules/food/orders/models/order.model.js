import mongoose from 'mongoose';

import { resolveOrderPromise, PROMISE_TERMINAL_STATUSES } from '../helpers/promise.util.js';

const orderItemSchema = new mongoose.Schema(
    {
        itemId: { type: String, required: true, trim: true },
        name: { type: String, required: true, trim: true },
        variantId: { type: String, trim: true, default: '' },
        variantName: { type: String, trim: true, default: '' },
        variantPrice: { type: Number, min: 0, default: 0 },
        price: { type: Number, required: true, min: 0 },
        /** Compare-at / other-platform unit price snapshot at order time. */
        otherPrice: { type: Number, min: 0, default: 0 },
        quantity: { type: Number, required: true, min: 1 },
        /**
         * What the picker actually found, when that differs from what was
         * ordered. Null means "everything" — which is every line on every
         * order that predates short-picking, so nothing has to be backfilled.
         *
         * `quantity` deliberately keeps saying what the customer asked for:
         * the invoice has to show both, and overwriting the ordered figure
         * would erase the evidence that anything went short.
         */
        fulfilledQuantity: { type: Number, default: null, min: 0 },
        /**
         * Which intakes these units came from, chosen by expiry at order time.
         *
         * Kept on the line so a cancellation returns units to the batches they
         * actually left — putting them back on the soonest-expiring batch
         * instead would quietly extend their life — and so a recall or a
         * complaint can be traced to a carton.
         */
        batchAllocations: {
            type: [
                new mongoose.Schema(
                    {
                        batchId: { type: String, trim: true, default: '' },
                        batchNo: { type: String, trim: true, default: '' },
                        expiryDate: { type: Date, default: null },
                        quantity: { type: Number, min: 0, default: 0 }
                    },
                    { _id: false }
                )
            ],
            default: []
        },
        /** Set on a line swapped in for one the shelf could not supply. */
        substitutedForItemId: { type: String, trim: true, default: '' },
        substitutedForName: { type: String, trim: true, default: '' },
        isVeg: { type: Boolean, default: true },
        /**
         * Rate this line was taxed at, snapshotted like the price is: a
         * product's GST slab can be reclassified, and the invoice has to keep
         * saying what was actually charged. null means the order-wide rate.
         */
        gstRate: { type: Number, min: 0, max: 100, default: null },
        brand: { type: String, trim: true, default: '' },
        packSize: { type: String, trim: true, default: '' },
        /**
         * Unit cost at order time, for margin reporting.
         *
         * Snapshotted for the same reason the price and the category are: a
         * product's purchase price changes, and a report of what a sale earned
         * has to use the cost that applied then, not today's. null means the
         * cost was unknown when the order was placed — the profit contribution
         * of such a line is reported as zero rather than guessed.
         */
        purchasePrice: { type: Number, min: 0, default: null },
        /**
         * Line-level discount in rupees, entered at the POS counter. Zero for
         * app orders, which only ever discount through a coupon on the whole
         * bill. Kept per line so a receipt can print what each line was
         * knocked down by, and so the totals strip can add them back up.
         */
        discount: { type: Number, min: 0, default: 0 },
        /**
         * Category this line belonged to, snapshotted at order time.
         *
         * Without it, "top selling categories" had to join order lines back to
         * the live catalogue by product name -- which silently drops every
         * product since renamed or deleted, and mis-attributes any two sellers
         * that use the same name. Recorded like the price is, and for the same
         * reason: the report must describe what was sold, not what the
         * catalogue happens to say today.
         */
        categoryId: { type: mongoose.Schema.Types.ObjectId, default: null },
        categoryName: { type: String, trim: true, default: '' },
        image: { type: String, default: '' },
        notes: { type: String, default: '' },
        /**
         * Add-ons chosen for this line, priced and named as at order time.
         *
         * Recorded rather than derived: an add-on's price can change, and the
         * order must keep what the customer was actually charged. `price` here
         * is per unit of the line, already folded into `price` above.
         *
         * The field did not exist before, so add-ons the customer selected were
         * dropped entirely — not billed, not shown, not recoverable afterwards.
         */
        addons: {
            type: [
                new mongoose.Schema(
                    {
                        addonId: { type: String, trim: true, default: '' },
                        name: { type: String, trim: true, default: '' },
                        price: { type: Number, min: 0, default: 0 }
                    },
                    { _id: false }
                )
            ],
            default: []
        }
    },
    { _id: false }
);

const deliveryAddressSchema = new mongoose.Schema(
    {
        label: { type: String, enum: ['Home', 'Office', 'Other'], default: 'Home' },
        name: { type: String, default: '', trim: true },
        fullName: { type: String, default: '', trim: true },
        flatNumber: { type: String, default: '', trim: true },
        blockNumber: { type: String, default: '', trim: true },
        colonyName: { type: String, default: '', trim: true },
        street: { type: String, required: true, trim: true },
        additionalDetails: { type: String, default: '', trim: true },
        city: { type: String, required: true, trim: true },
        state: { type: String, required: true, trim: true },
        zipCode: { type: String, default: '', trim: true },
        phone: { type: String, default: '', trim: true },
        location: {
            type: { type: String, enum: ['Point'], default: 'Point' },
            coordinates: { type: [Number], default: undefined }
        }
    },
    { _id: false }
);

const pricingSchema = new mongoose.Schema(
    {
        subtotal: { type: Number, required: true, min: 0 },
        tax: { type: Number, default: 0, min: 0 },
        packagingFee: { type: Number, default: 0, min: 0 },
        deliveryFee: { type: Number, default: 0, min: 0 },
        deliveryFeeGst: { type: Number, default: 0, min: 0 },
        platformFee: { type: Number, default: 0, min: 0 },
        /** Extra surcharge when user selects Quick Mode (also included in platformFee). */
        quickDeliveryFee: { type: Number, default: 0, min: 0 },
        /**
         * Charged on a basket below the configured threshold: the trip costs
         * the same whatever is in the bag. Its own line rather than folded
         * into the platform fee, so a customer can see what it was for.
         */
        smallCartFee: { type: Number, default: 0, min: 0 },
        deliveryMode: { type: String, enum: ['basic', 'quick'], default: 'basic' },
        restaurantCommission: { type: Number, default: 0, min: 0 },
        discount: { type: Number, default: 0, min: 0 },
        couponCode: { type: String, default: null, trim: true, uppercase: true },
        /**
         * The part of `discount` the counter staff entered by hand (flat
         * amount, percentage, or per-line), as opposed to what a coupon gave.
         * `discount` already includes it; this is the split, so reports can
         * tell a coupon campaign apart from a cashier's goodwill.
         */
        manualDiscount: { type: Number, default: 0, min: 0 },
        /** Extra charges typed in at the counter (a service charge, a bag). */
        additionalCharges: { type: Number, default: 0, min: 0 },
        /**
         * Paise dropped or added to land the bill on a whole rupee. Signed:
         * -0.40 means the customer paid 40p less than the arithmetic total.
         * Already folded into `total`.
         */
        roundOff: { type: Number, default: 0 },
        total: { type: Number, required: true, min: 0 },
        currency: { type: String, default: 'INR' },
        /** Straight-line restaurant ↔ customer km (fee calculation) */
        distanceKm: { type: Number, default: null, min: 0 },
        /** Driving / road restaurant ↔ customer km (Directions API) */
        roadDistanceKm: { type: Number, default: null, min: 0 },
        roadDurationMins: { type: Number, default: null, min: 0 },
    },
    { _id: false }
);

const paymentSchema = new mongoose.Schema(
    {
        // 'upi' and 'card' are counter tenders: money the seller took in person
        // at the POS and recorded after the fact. They never involve the
        // gateway — an app customer paying by card goes through 'razorpay'.
        method: {
            type: String,
            enum: ['cash', 'razorpay', 'razorpay_qr', 'wallet', 'upi', 'card'],
            required: true
        },
        status: {
            type: String,
            enum: [
                'cod_pending',
                'created',
                'authorized',
                'paid',
                'failed',
                'refunded',
                'pending_qr'
            ],
            default: 'cod_pending'
        },
        amountDue: { type: Number, min: 0 },
        razorpay: {
            orderId: { type: String },
            paymentId: { type: String },
            signature: { type: String }
        },
        qr: {
            qrId: { type: String },
            imageUrl: { type: String },
            paymentLinkId: { type: String },
            shortUrl: { type: String },
            status: { type: String },
            expiresAt: { type: Date }
        },
        // ✅ NEW: Added refund object to track refund status without breaking existing flow
        refund: {
            status: { 
                type: String, 
                enum: ['none', 'pending', 'processed', 'failed'], 
                default: 'none' 
            },
            amount: { type: Number, default: 0 },
            refundId: { type: String, default: '' },
            processedAt: { type: Date }
        }
    },
    { _id: false }
);

/**
 * What the counter knew that the app never asks: how the customer is taking
 * the food, which table, who rang it up, and how the money actually arrived.
 *
 * `tenders` is the split when a bill is paid by more than one method; for a
 * plain cash sale it is a single entry. `dueAmount` is what is still owed on
 * a pay-later bill and drops as payments are added against it.
 */
const posTenderSchema = new mongoose.Schema(
    {
        mode: { type: String, enum: ['cash', 'upi', 'card'], required: true },
        amount: { type: Number, required: true, min: 0 },
        at: { type: Date, default: Date.now },
        note: { type: String, trim: true, default: '' },
        /**
         * Card details, captured at the counter.
         *
         * Structured rather than folded into `note` because the transaction
         * number is what a chargeback or a settlement query is traced by, and
         * fishing it back out of a free-text string is not a thing anyone
         * should have to do. All optional: a shop that does not record them
         * still takes cards.
         */
        bankAccount: { type: String, trim: true, default: '' },
        customerBank: { type: String, trim: true, default: '' },
        cardHolder: { type: String, trim: true, default: '' },
        transactionNo: { type: String, trim: true, default: '' }
    },
    { _id: false }
);

const posSchema = new mongoose.Schema(
    {
        orderType: {
            type: String,
            enum: ['dine_in', 'take_away', 'walk_in', 'delivery'],
            default: 'walk_in'
        },
        tableNo: { type: String, trim: true, default: '' },
        salesman: { type: String, trim: true, default: '' },
        remarks: { type: String, trim: true, default: '' },
        /** 'pay_later' means nothing was taken at the counter. */
        paymentMode: {
            type: String,
            enum: ['cash', 'upi', 'card', 'multiple', 'pay_later'],
            default: 'cash'
        },
        tenders: { type: [posTenderSchema], default: [] },
        dueAmount: { type: Number, min: 0, default: 0 },
        /** Cash handed back when more was received than the bill; tenders record what came in. */
        changeGiven: { type: Number, min: 0, default: 0 },
        /** Bill number as printed. Same as order_id; here so it survives renumbering. */
        billNo: { type: String, trim: true, default: '' }
    },
    { _id: false }
);

const dispatchSchema = new mongoose.Schema(
    {
        modeAtCreation: { type: String, enum: ['auto'], default: 'auto' },
        /**
         * How this order reached the rider it has.
         *
         * 'fleet' is handed straight to one named rider from the seller's own
         * fleet; 'auto' is offered to every eligible rider in the shared pool
         * and raced; 'manual' is a person choosing. Worth recording because
         * they fail differently — a fleet order with nobody free waits, and a
         * pool order with nobody free was shouted at an empty room — and from
         * the order alone the two were indistinguishable.
         */
        assignmentMode: {
            type: String,
            enum: ['auto', 'fleet', 'manual'],
            default: null,
            index: true
        },
        /** Set when a person assigned it, so ops can tell who overrode what. */
        assignedByRole: { type: String, enum: ['ADMIN', 'RESTAURANT'], default: null },
        status: {
            type: String,
            enum: ['unassigned', 'assigned', 'accepted', 'rejected', 'cancelled'],
            default: 'unassigned'
        },
        deliveryPartnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodDeliveryPartner', default: null },
        assignedAt: { type: Date },
        acceptedAt: { type: Date },
        /** List of partners who were offered this order (to avoid repeats and track timeouts) */
        offeredTo: [{
            partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodDeliveryPartner' },
            at: { type: Date, default: Date.now },
            action: { type: String, enum: ['offered', 'rejected', 'timeout', 'deassigned'], default: 'offered' }
        }],
        dispatchingAt: { type: Date }
    },
    { _id: false }
);

const deliveryStateSchema = new mongoose.Schema(
    {
        currentPhase: {
            type: String,
            enum: [
                'en_route_to_pickup',
                'at_pickup',
                'en_route_to_delivery',
                'at_drop',
                'delivered',
                'completed'
            ],
            default: 'en_route_to_pickup'
        },
        status: { type: String, default: '' },
        reachedPickupAt: { type: Date, default: null },
        reachedDropAt: { type: Date, default: null },
        pickedUpAt: { type: Date, default: null },
        deliveredAt: { type: Date, default: null }
    },
    { _id: false }
);

/**
 * What the customer was told, and whether it was kept.
 *
 * The promise is the product in quick commerce, and until this existed it was
 * computed for display at quote time and thrown away — so "what share of
 * orders arrived in time?" could not be answered for a single past order, let
 * alone a week of them. Recomputing it later is not the same thing: the
 * distance, the fee bands and the packing constant all move, and the honest
 * question is whether *the number the customer actually saw* was met.
 *
 * `quotedMinutes` is null on an order placed with no usable distance, and on
 * every order that predates this field. `outcome` stays 'pending' until the
 * order reaches a terminal state, so an order in flight is never miscounted as
 * on time.
 */
const promiseSchema = new mongoose.Schema(
    {
        /** Minutes shown to the customer before they committed. */
        quotedMinutes: { type: Number, default: null, min: 0 },
        /** The clock the quote started from — order placement, or the booked window. */
        quotedAt: { type: Date, default: null },
        /** quotedAt + quotedMinutes. The deadline, stored so nobody re-derives it. */
        dueBy: { type: Date, default: null, index: true },
        /** Straight-line store→customer distance the quote was built on. */
        distanceKm: { type: Number, default: null, min: 0 },
        outcome: {
            type: String,
            enum: ['pending', 'on_time', 'late', 'not_applicable'],
            default: 'pending',
            index: true
        },
        /**
         * Signed seconds against the deadline: negative is early, positive is
         * late. Stored at delivery so a report is a sum, not a per-row date
         * subtraction across two optional fields.
         */
        varianceSeconds: { type: Number, default: null }
    },
    { _id: false }
);

/**
 * What happened at the shelf, when the basket could not be filled as ordered.
 *
 * Groceries go short — this is the most common real event in the whole system
 * and until now the only expressible answers were "deliver everything" or
 * "cancel the lot". A short pick is neither: the customer usually wants the
 * other nine things.
 */
const fulfillmentSchema = new mongoose.Schema(
    {
        status: {
            type: String,
            enum: ['complete', 'partial', 'substituted'],
            default: 'complete',
            index: true
        },
        adjustedAt: { type: Date, default: null },
        adjustedByRole: { type: String, enum: ['RESTAURANT', 'ADMIN', 'SYSTEM'], default: undefined },
        /**
         * What the bill was before anything went short — captured once, on the
         * first adjustment, and never moved again.
         *
         * Without it `shortfallAmount` could only ever describe the most recent
         * change: an order short-picked and then substituted would report the
         * second delta alone, and a refund paid against that figure would
         * underpay the customer by the first one.
         */
        originalTotal: { type: Number, default: null, min: 0 },
        /** Rupees off the ORIGINAL bill, cumulative across every adjustment. */
        shortfallAmount: { type: Number, default: 0, min: 0 },
        note: { type: String, trim: true, default: '' }
    },
    { _id: false }
);

const statusHistorySchema = new mongoose.Schema(
    {
        at: { type: Date, default: Date.now },
        byRole: { type: String, enum: ['USER', 'RESTAURANT', 'DELIVERY_PARTNER', 'ADMIN', 'SYSTEM'] },
        byId: { type: mongoose.Schema.Types.ObjectId },
        from: { type: String },
        to: { type: String },
        note: { type: String, default: '' }
    },
    { _id: false }
);

const orderEntityRatingSchema = new mongoose.Schema(
    {
        rating: { type: Number, min: 1, max: 5 },
        comment: { type: String, default: '', trim: true },
        ratedAt: { type: Date, default: Date.now }
    },
    { _id: false }
);

/** One rated dish. itemId matches items[].itemId on the same order. */
const orderItemRatingSchema = new mongoose.Schema(
    {
        itemId: { type: String, required: true, trim: true },
        name: { type: String, default: '', trim: true },
        rating: { type: Number, min: 1, max: 5, required: true },
        comment: { type: String, default: '', trim: true },
        ratedAt: { type: Date, default: Date.now }
    },
    { _id: false }
);

const orderRatingsSchema = new mongoose.Schema(
    {
        restaurant: { type: orderEntityRatingSchema, default: undefined },
        deliveryPartner: { type: orderEntityRatingSchema, default: undefined },
        /** The CUSTOMER, rated by the delivery partner after handover. */
        customer: { type: orderEntityRatingSchema, default: undefined },
        /** Per-dish ratings from the customer. */
        items: { type: [orderItemRatingSchema], default: [] }
    },
    { _id: false }
);

const deliveryVerificationSchema = new mongoose.Schema(
    {
        dropOtp: {
            required: { type: Boolean, default: false },
            verified: { type: Boolean, default: false }
        }
    },
    { _id: false }
);

const orderSchema = new mongoose.Schema(
    {
        order_id: {
            type: String,
            unique: true,
            sparse: true,
            index: true
        },
        /** Compatibility alias: satisfies rogue unique index 'orderId_1' found in legacy deployments. */
        orderId: {
            type: String,
            unique: true,
            sparse: true,
            index: true
        },
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'FoodUser',
            required: true
        },
        restaurantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'FoodRestaurant',
            required: true
        },
        zoneId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'FoodZone',
            index: true
        },
        transactionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'FoodTransaction',
            index: true
        },
        items: {
            type: [orderItemSchema],
            required: true,
            validate: (v) => Array.isArray(v) && v.length > 0
        },
        deliveryAddress: {
            type: deliveryAddressSchema,
            required: true
        },
        customerName: { type: String, default: '', trim: true },
        customerPhone: { type: String, default: '', trim: true },
        pricing: {
            type: pricingSchema,
            required: false
        },
        /**
         * Denormalized payment snapshot for fast reads & legacy clients.
         * Authoritative audit trail: collection `food_order_payments` (FoodOrderPayment model).
         */
        payment: {
            type: paymentSchema,
            required: false
        },
        // Where this order originated. 'pos' = rung up at the seller's counter
        // (or by an admin on the seller's behalf); everything else about the
        // order (pricing, stock, transaction ledger) flows through the exact
        // same path.
        source: {
            type: String,
            enum: ['app', 'pos'],
            default: 'app',
            index: true
        },
        /** Counter details. Present only when source is 'pos'. */
        pos: {
            type: posSchema,
            default: undefined
        },
        orderStatus: {
            type: String,
            enum: [
                'pending_payment',
                'created',
                'confirmed',
                'preparing',
                'ready_for_pickup',
                'reached_pickup',
                'picked_up',
                'reached_drop',
                'delivered',
                'cancelled_by_user',
                'cancelled_by_restaurant',
                'cancelled_by_admin'
            ],
            default: 'created'
        },
        dispatch: {
            type: dispatchSchema,
            default: () => ({})
        },
        deliveryState: {
            type: deliveryStateSchema,
            default: () => ({})
        },
        promise: {
            type: promiseSchema,
            default: () => ({})
        },
        fulfillment: {
            type: fulfillmentSchema,
            default: () => ({})
        },
        statusHistory: {
            type: [statusHistorySchema],
            default: []
        },
        ratings: {
            type: orderRatingsSchema,
            default: () => ({})
        },
        note: { type: String, default: '', trim: true },
        deliveryInstructions: { type: String, default: '', trim: true },
        acceptanceWindowSeconds: { type: Number, default: 240, min: 1 },
        acceptanceDeadlineAt: { type: Date, default: null },
        /** Idempotency guard so retries/duplicate calls never double-push the "new order" alert. */
        restaurantNotifiedAt: { type: Date, default: null },
        /** Set once stock was decremented for this order; absent on pre-inventory orders. */
        stockReservedAt: { type: Date, default: null },
        /**
         * Set once stock was given back. Guards the restock, which is reachable
         * from user cancel, seller cancel, admin cancel, the acceptance-timeout
         * sweep and two delete paths — several of which can race. Restocking
         * twice silently inflates inventory, and nothing downstream would notice.
         */
        stockRestoredAt: { type: Date, default: null },
        sendCutlery: { type: Boolean, default: true },
        /**
         * What to do when the shelf cannot supply a line.
         *
         * 'refund' is the default because a substitution spends the customer's
         * money on something they did not choose, and silence is not consent —
         * the lactose-free shopper handed ordinary milk has been sold the one
         * thing they were avoiding. A customer who does not mind says so at
         * checkout, and only then may the picker swap.
         */
        substitutionPreference: {
            type: String,
            enum: ['refund', 'allow'],
            default: 'refund'
        },
        deliveryFleet: { type: String, default: 'standard', trim: true },
        scheduledAt: { type: Date, default: null },
        /**
         * The window the customer booked, when they booked one.
         *
         * Absent means instant — the order goes out now, on the path it always
         * took. The label and times are snapshotted alongside the id so an
         * order still reads "7 – 8 AM" after the slot is renamed or retired,
         * which is what the customer was told and what they will quote back.
         */
        deliverySlot: {
            slotId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodDeliverySlot', default: null, index: true },
            label: { type: String, trim: true, default: '' },
            startTime: { type: String, trim: true, default: '' },
            endTime: { type: String, trim: true, default: '' }
        },
        riderEarning: { type: Number, default: 0, min: 0 },
        // Can be negative when discounts/rider pay exceed platform income; keep the real value visible.
        platformProfit: { type: Number, default: 0 },
        /** Restaurant ↔ customer driving distance (km) for delivery-partner offer UI */
        tripDistanceKm: { type: Number, default: null, min: 0 },
        tripDurationMins: { type: Number, default: null, min: 0 },
        /** Plain 4-digit OTP for handover; cleared after successful verify (never expose to partner in API responses). */
        deliveryOtp: { type: String, default: '', select: false },
        deliveryVerification: {
            type: deliveryVerificationSchema,
            default: () => ({})
        },
        /** Latest rider location for this specific order (GeoJSON Point) */
        lastRiderLocation: {
            type: { type: String, enum: ['Point'] },
            coordinates: { type: [Number] }
        }
    },
    {
        collection: 'food_orders',
        timestamps: true
    }
);

orderSchema.index({ createdAt: -1 });
orderSchema.index({ orderStatus: 1, createdAt: -1 });
orderSchema.index({ 'deliveryAddress.location': '2dsphere' });
orderSchema.index({ lastRiderLocation: '2dsphere' });
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ restaurantId: 1, orderStatus: 1, createdAt: -1 });
orderSchema.index({ 'dispatch.deliveryPartnerId': 1, orderStatus: 1 });
orderSchema.index({ 'dispatch.status': 1, orderStatus: 1 });
orderSchema.index({ 'dispatch.status': 1, orderStatus: 1, updatedAt: -1 });
orderSchema.index({ 'dispatch.deliveryPartnerId': 1, 'dispatch.status': 1, updatedAt: -1 });
orderSchema.index({ 'payment.status': 1, createdAt: -1 });
orderSchema.index({ 'payment.method': 1, createdAt: -1 });

/**
 * Mints the printed order number on a document that does not have one yet.
 *
 * Separate from the pre-save hook so a caller can ask for the number *before*
 * saving. Anything written during order creation that quotes the order — the
 * stock ledger, most visibly — otherwise records an empty label, because the
 * hook does not run until `save()`. It is idempotent: the hook calls it too,
 * and it leaves an existing number alone.
 */
orderSchema.methods.ensureOrderId = async function ensureOrderId() {
    if (!this.order_id) {
        // 6 timestamp digits + 4 random digits, verified against the collection.
        // The old 4+3 format collided after a few thousand orders (birthday paradox),
        // which made display-id lookups match the wrong order.
        for (let attempt = 0; attempt < 5 && !this.order_id; attempt += 1) {
            const timestamp = Date.now().toString().slice(-6);
            const random = Math.floor(1000 + Math.random() * 9000);
            const candidate = `FOD-${timestamp}${random}`;
            const exists = await this.constructor.exists({
                $or: [{ order_id: candidate }, { orderId: candidate }],
            });
            if (!exists) this.order_id = candidate;
        }
        if (!this.order_id) {
            // Guaranteed unique: derived from this document's own ObjectId.
            this.order_id = `FOD-${this._id.toString().slice(-10).toUpperCase()}`;
        }
    }
    // Synchronize camelCase alias to satisfy unique index 'orderId_1'
    if (this.order_id) {
        this.orderId = this.order_id;
    }
    return this.order_id;
};

orderSchema.pre('save', async function (next) {
    try {
        await this.ensureOrderId();

        // Settle the delivery promise here rather than at each of the five
        // places an order can reach a terminal state — the rider completing a
        // trip, the seller or admin marking it delivered, and the three
        // cancellation paths. Scattering it is how the other status-derived
        // fields in this file drifted; a hook cannot be forgotten by a new
        // caller. resolveOrderPromise returns the promise unchanged unless
        // there is something to settle, so this is safe on every save.
        // Only on the way INTO a terminal state, and never on insert: a new
        // document reports every path as modified, so without the isNew guard
        // an order would settle as 'not_applicable' the moment it was created
        // and could never be scored. And without the terminal check, any
        // ordinary status change on the way — confirmed, preparing, picked_up —
        // would do the same.
        if (!this.isNew
            && PROMISE_TERMINAL_STATUSES.includes(String(this.orderStatus))
            && (this.isModified('orderStatus') || this.isModified('deliveryState'))) {
            this.promise = resolveOrderPromise(this.promise?.toObject?.() || this.promise, {
                at: this.deliveryState?.deliveredAt || new Date(),
                status: this.orderStatus,
            });
        }

        next();
    } catch (err) {
        next(err);
    }
});

export const FoodOrder = mongoose.model('FoodOrder', orderSchema);

const settingsSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true, trim: true },
        dispatchMode: { type: String, enum: ['auto'], default: 'auto' },
        /**
         * Proof of life from the scheduled-jobs process.
         *
         * That process is separate from the API, and nothing in the system
         * could tell whether it was running -- the only way to answer "are the
         * sweeps happening" was a shell on the box. Which matters more than it
         * used to: an order the seller never accepts now gets its rider from a
         * sweep, so a scheduler that quietly died means orders that quietly
         * never reach anybody.
         *
         * Host and pid are recorded because the failure this catches second is
         * two schedulers running, each undoing the other's assumptions.
         */
        heartbeatAt: { type: Date, default: null },
        heartbeatHost: { type: String, default: '' },
        heartbeatPid: { type: Number, default: null },
        heartbeatJobs: { type: [String], default: [] },
        updatedBy: {
            role: { type: String },
            adminId: { type: mongoose.Schema.Types.ObjectId },
            at: { type: Date }
        }
    },
    { collection: 'food_settings', timestamps: true }
);

export const FoodSettings = mongoose.model('FoodSettings', settingsSchema);
