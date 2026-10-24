import { FoodRestaurant } from '../models/restaurant.model.js';
import { attachOutletTimingsToRestaurants } from './outletTimings.service.js';
import { getRestaurantAvailabilityStatus } from '../helpers/restaurantAvailability.helper.js';
import { closedNoticeFor } from '../helpers/appStatus.helper.js';

/**
 * Which stores are open for customers right now — for the endpoints that LIST products.
 *
 * Checkout, the cart and /restaurants/:id/app-status already refuse a closed store, using
 * getRestaurantAvailabilityStatus. A product list that still showed that store's shelves sent
 * customers into carts they could not check out, so every list a customer browses applies the
 * same verdict. It is the one check, not a second copy of it: the admin's App timings (forced
 * closed, daily window, till required online), the seller's pause switch, the outlet's own
 * hours and open days, and a deactivated store all decide it.
 *
 * HIDE_CLOSED_STORE_PRODUCTS=false switches the filtering off without a deploy.
 */

/** Everything the availability check reads, so a caller's own projection cannot leave one out. */
export const OPEN_CHECK_FIELDS =
    'isActive isAcceptingOrders openingTime closingTime openDays deliveryTimings appTimings posLastSeenAt';

export const hidingClosedStores = () => String(process.env.HIDE_CLOSED_STORE_PRODUCTS ?? 'true') !== 'false';

/**
 * The stores from `stores` that are open at `now`, in their original order.
 *
 * `stores` are lean store documents selected with OPEN_CHECK_FIELDS. A store the schedule says is
 * closed is dropped; one with no schedule configured at all is open, as it is at checkout.
 */
export async function keepOpenStores(stores = [], now = new Date()) {
    if (!hidingClosedStores() || !Array.isArray(stores) || stores.length === 0) return stores;
    const withTimings = await attachOutletTimingsToRestaurants(stores, { useDefaults: false });
    return stores.filter((_, i) => getRestaurantAvailabilityStatus(withTimings[i], now).isOpen === true);
}

/** The ids (as strings) among `restaurantIds` that are open now. */
export async function openStoreIdSet(restaurantIds = [], now = new Date()) {
    const ids = [...new Set((restaurantIds || []).map((id) => String(id)).filter(Boolean))];
    if (ids.length === 0) return new Set();
    if (!hidingClosedStores()) return new Set(ids);
    const stores = await FoodRestaurant.find({ _id: { $in: ids } }).select(`_id ${OPEN_CHECK_FIELDS}`).lean();
    const open = await keepOpenStores(stores, now);
    return new Set(open.map((s) => String(s._id)));
}

/**
 * One store's verdict in the shape the apps show: open or not, why, and the sentence to display.
 * Used by the menu so a closed store's page can say so instead of just looking empty.
 */
export async function storeOpenNotice(restaurantId, now = new Date()) {
    if (!hidingClosedStores()) return { open: true, reason: 'open', message: '' };
    const store = await FoodRestaurant.findById(restaurantId).select(`_id ${OPEN_CHECK_FIELDS}`).lean();
    if (!store) return { open: false, reason: 'missing-restaurant', message: 'Store not found.' };
    const [withTimings] = await attachOutletTimingsToRestaurants([store], { useDefaults: false });
    const availability = getRestaurantAvailabilityStatus(withTimings, now);
    return {
        open: availability.isOpen === true,
        reason: availability.reason,
        message: availability.isOpen === true ? '' : closedNoticeFor(availability.appStatus),
    };
}
