import mongoose from 'mongoose';
import { DELIVERY_AVAILABILITY_STATUSES } from '../../../../constants/deliveryAvailability.js';

const normalizeRatingValue = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(5, Number(numeric.toFixed(1))));
};

const deliveryPartnerSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true
        },
        phone: {
            type: String,
            required: true,
            trim: true,
            unique: true
        },
        email: { type: String, trim: true },
        countryCode: {
            type: String,
            default: '+91'
        },
        address: {
            type: String
        },
        city: {
            type: String
        },
        state: {
            type: String
        },
        vehicleType: {
            type: String
        },
        vehicleName: {
            type: String
        },
        vehicleNumber: {
            type: String,
            unique: true,
            sparse: true,
            trim: true,
            uppercase: true
        },
        panNumber: {
            type: String
        },
        aadharNumber: {
            type: String
        },
        drivingLicenseNumber: {
            type: String,
            trim: true
        },
        profilePhoto: {
            type: String
        },
        fcmTokens: {
            type: [String],
            default: []
        },
        fcmTokenMobile: {
            type: [String],
            default: []
        },
        aadharPhoto: {
            type: String
        },
        panPhoto: {
            type: String
        },
        drivingLicensePhoto: {
            type: String
        },
        status: {
            type: String,
            enum: ['pending', 'approved', 'rejected', 'deactivated'],
            default: 'pending'
        },
        rejectionReason: { type: String },
        rejectedAt: { type: Date },
        approvedAt: { type: Date },
        bankAccountHolderName: { type: String },
        bankAccountNumber: { type: String },
        bankIfscCode: { type: String },
        bankName: { type: String },
        upiId: { type: String },
        upiQrCode: { type: String },
        /**
         * The zone-based dark-store toggle.
         *
         * When on, a location ping from a rider who is offline and standing
         * inside an active zone puts them online. Off by default and never
         * implicit: flipping somebody online without their say-so is the one
         * way this feature turns into a complaint, so it is opt-in per rider.
         *
         * It only ever lifts `offline`. A rider on a break, in the washroom or
         * dealing with a breakdown stays exactly where they put themselves --
         * those are deliberate and temporary, and walking past the shop is not
         * consent to start taking orders again.
         */
        autoOnlineInZone: { type: Boolean, default: false, index: true },
        availabilityStatus: {
            type: String,
            enum: DELIVERY_AVAILABILITY_STATUSES,
            default: 'offline'
        },
        // Set when a seller links this rider into their own manually-managed
        // fleet (see restaurant/services/deliveryFleet.service.js). Riders with
        // no restaurantId remain part of the legacy global auto-dispatch pool.
        restaurantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'FoodRestaurant',
            default: null,
            index: true
        },
        lastLocation: {
            type: { type: String, enum: ['Point'] },
            coordinates: { type: [Number] }
        },
        lastLat: { type: Number },
        lastLng: { type: Number },
        lastLocationAt: { type: Date },
        referralCode: { type: String, index: true },
        referredBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'FoodDeliveryPartner',
            default: null,
            index: true
        },
        referralCount: { type: Number, default: 0, min: 0 },
        // Admin-defined dynamic registration answers, keyed by field.key.
        customFields: { type: mongoose.Schema.Types.Mixed, default: {} },
        // Admin-defined document uploads, keyed by field.key → stored URL.
        customDocuments: { type: mongoose.Schema.Types.Mixed, default: {} },
        rating: {
            type: Number,
            default: 0,
            min: 0,
            max: 5,
            set: normalizeRatingValue
        },
        totalRatings: { type: Number, default: 0, min: 0 },
        // Lifetime count of completed deliveries, shown on the customer tracking screen.
        totalDeliveries: { type: Number, default: 0, min: 0 },
        /**
         * Bumped on every successful login, and embedded in the JWT that login
         * issues. A token whose version is behind the stored one is rejected, so
         * signing in on a new device silently invalidates every older device
         * rather than leaving the account live in two places at once.
         */
        tokenVersion: { type: Number, default: 0 }
    },
    {
        collection: 'food_delivery_partners',
        timestamps: true
    }
);

// Indices
deliveryPartnerSchema.index({ lastLocation: '2dsphere' });

export const FoodDeliveryPartner = mongoose.model('FoodDeliveryPartner', deliveryPartnerSchema);

