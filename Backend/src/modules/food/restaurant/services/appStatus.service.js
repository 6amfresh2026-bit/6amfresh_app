import mongoose from 'mongoose';
import { FoodRestaurant } from '../models/restaurant.model.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { getRestaurantAvailabilityStatus } from '../helpers/restaurantAvailability.helper.js';
import { closedNoticeFor } from '../helpers/appStatus.helper.js';
import { loadRestaurantForOrdering } from '../../orders/services/order-pricing.service.js';

/**
 * The till's heartbeat, and the answer the customer app polls for "can I order from this store".
 */

/** The till checks in. One atomic stamp; the store's own id comes from the caller's session. */
export async function recordPosHeartbeat(restaurantId) {
    if (!restaurantId || !mongoose.Types.ObjectId.isValid(String(restaurantId))) {
        throw new ValidationError('Store not found');
    }
    const now = new Date();
    const result = await FoodRestaurant.updateOne({ _id: restaurantId }, { $set: { posLastSeenAt: now } });
    if (result.matchedCount === 0) throw new ValidationError('Store not found');
    return { ok: true, serverTime: now.toISOString() };
}

/**
 * Whether customers can order from a store right now, and instant delivery, computed on the spot.
 * This is the same check checkout runs, so the app and the server cannot disagree. It is served
 * without a cache on purpose: the admin's changes and the till going on or off line have to reach
 * customers in seconds, which a cached store page cannot do.
 */
export async function getStoreAppStatus(restaurantId, now = new Date()) {
    const restaurant = await loadRestaurantForOrdering(restaurantId);
    const availability = getRestaurantAvailabilityStatus(restaurant, now);
    const open = availability.isOpen === true;
    return {
        open,
        reason: availability.reason,
        // What to tell the customer: the admin's message if they wrote one, else a plain sentence.
        message: open ? '' : closedNoticeFor(availability.appStatus),
        instantLive: availability.instantLive === true,
        serverTime: now.toISOString()
    };
}
