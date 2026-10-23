import mongoose from 'mongoose';

/**
 * A person who runs one store's till and signs in to the POS with a username and password the
 * admin gave them. They are not the store owner: the account belongs to a store, and its session
 * can only reach the POS (see POS_SESSION_ALLOWED in auth.middleware).
 */
const posUserSchema = new mongoose.Schema(
    {
        restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant', required: true, index: true },
        name: { type: String, required: true, trim: true, maxlength: 80 },
        // Lower-case, globally unique: a cashier signs in with it alone, without naming the store.
        username: { type: String, required: true, unique: true, lowercase: true, trim: true },
        phone: { type: String, trim: true, default: '' },
        password: { type: String, required: true },
        isActive: { type: Boolean, default: true },
        // What this person may do at the till (see posPermissions.js). Left unset, everything.
        permissions: { type: [String], default: undefined },
        // Caps per bill; 0 means no cap.
        limits: {
            maxBillAmount: { type: Number, default: 0, min: 0 },
            maxDiscountPercent: { type: Number, default: 0, min: 0, max: 100 }
        },
        // Bumped on a password reset or deactivation so sessions already open stop working.
        tokenVersion: { type: Number, default: 0 },
        lastLoginAt: { type: Date, default: null },
        createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    { timestamps: true, collection: 'food_pos_users' }
);

export const FoodPosUser = mongoose.model('FoodPosUser', posUserSchema);
