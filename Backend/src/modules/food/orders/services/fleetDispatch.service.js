import mongoose from 'mongoose';

import { FoodDeliveryPartner } from '../../delivery/models/deliveryPartner.model.js';
import { haversineKm, parseGeoPoint } from '../../shared/geo.utils.js';
import { FoodOrder } from '../models/order.model.js';
import { canPartnerTakeOrder, TERMINAL_ORDER_STATUSES } from './order.helpers.js';

/**
 * Choosing a rider from the seller's own fleet.
 *
 * Until now a seller who linked even one rider lost automatic dispatch
 * altogether: restaurantUsesManualDispatch() saw the fleet and tryAutoAssign
 * skipped the order, so every order waited for somebody to notice it and
 * assign by hand. Having your own riders made dispatch worse, which is the
 * opposite of what owning a fleet is for.
 *
 * The rule the shop actually wants is "give it to one of my riders who is
 * free right now", and that is what this picks.
 */

/**
 * How stale a rider's last GPS ping may be before we stop trusting it.
 *
 * Deliberately generous, and the reason is written out in
 * order-dispatch.service.js: Android Doze stops the background upload, so a
 * rider standing outside the shop with the app backgrounded goes quiet. In a
 * named fleet this matters less than in the shared pool -- the seller knows
 * who is on shift -- so a quiet rider is ranked last rather than dropped.
 */
const STALE_GPS_MS = Number(process.env.DISPATCH_STALE_GPS_MS) || 45 * 60 * 1000;

const isFresh = (partner) =>
    partner?.lastLocationAt && Date.now() - new Date(partner.lastLocationAt).getTime() <= STALE_GPS_MS;

/**
 * Everything a rider is holding: accepted, and also assigned-but-not-yet-tapped.
 *
 * getActiveDeliveriesForPartner() counts only accepted orders, which is right
 * for the shared pool -- there 'assigned' is a pending offer that may time out
 * and go to somebody else, so it is not yet work.
 *
 * A fleet assignment is not an offer. The order is already theirs the moment it
 * is written, and counting only accepted ones meant a rider who had not opened
 * the app yet still read as free, so the next order was handed to them too, and
 * the next. One rider ended up holding every order the shop took while
 * everybody else sat idle.
 */
async function getHeldOrdersForPartner(deliveryPartnerId) {
    if (!deliveryPartnerId) return [];
    return FoodOrder.find({
        'dispatch.deliveryPartnerId': new mongoose.Types.ObjectId(String(deliveryPartnerId)),
        'dispatch.status': { $in: ['accepted', 'assigned'] },
        orderStatus: { $nin: TERMINAL_ORDER_STATUSES }
    })
        .select('_id order_id restaurantId deliveryAddress deliveryState orderStatus promise payment pricing')
        .lean();
}

/** Riders this seller has linked, online and cleared to work. */
export async function listAvailableFleetPartners(restaurantId) {
    if (!restaurantId || !mongoose.Types.ObjectId.isValid(String(restaurantId))) return [];
    // 'pending' rides along outside production for the same reason the shared
    // pool allows it: a dev database has no approved riders in it.
    const allowedStatuses = process.env.NODE_ENV === 'production' ? ['approved'] : ['approved', 'pending'];

    return FoodDeliveryPartner.find({
        restaurantId: new mongoose.Types.ObjectId(String(restaurantId)),
        availabilityStatus: 'online',
        status: { $in: allowedStatuses }
    })
        .select('_id name phone status availabilityStatus lastLat lastLng lastLocationAt restaurantId')
        .lean();
}

/**
 * The seller's rider best placed to take this order, or null.
 *
 * "Available" means carrying nothing at all -- a rider with an empty hand is
 * the one the shop means when it says free, and an order handed to somebody
 * mid-delivery arrives later than the promise printed on it.
 *
 * A rider already carrying work is only considered once nobody is free, and
 * then only if canPartnerTakeOrder() agrees: same store, not yet collected,
 * drops close together. Those are the batching rules, and they exist so the
 * customer already on board is not paying for this one's doorstep.
 *
 * Among equals, nearest to the store wins, because that is the part of the
 * promise nobody can make up later.
 */
export async function pickFleetPartnerForOrder(order, restaurant, { excludeIds = [] } = {}) {
    const restaurantId = restaurant?._id || order?.restaurantId;
    const partners = await listAvailableFleetPartners(restaurantId);
    if (partners.length === 0) return null;

    const excluded = new Set((excludeIds || []).map(String));
    const store = parseGeoPoint(restaurant);

    const free = [];
    const shareable = [];

    for (const partner of partners) {
        if (excluded.has(String(partner._id))) continue;

        const active = await getHeldOrdersForPartner(partner._id);
        const distanceKm =
            store && Number.isFinite(Number(partner.lastLat)) && Number.isFinite(Number(partner.lastLng))
                ? haversineKm(store.lat, store.lng, Number(partner.lastLat), Number(partner.lastLng))
                : null;

        const entry = { partner, distanceKm, activeCount: active.length, fresh: isFresh(partner) };

        if (active.length === 0) {
            free.push(entry);
            continue;
        }

        const verdict = canPartnerTakeOrder(active, order);
        if (verdict.allowed) shareable.push(entry);
    }

    // A rider whose phone has gone quiet still gets the order, just after
    // everyone we can see. Ranking beats excluding here: the alternative is an
    // order nobody delivers.
    const rank = (a, b) => {
        if (a.fresh !== b.fresh) return a.fresh ? -1 : 1;
        if (a.distanceKm === null && b.distanceKm === null) return 0;
        if (a.distanceKm === null) return 1;
        if (b.distanceKm === null) return -1;
        return a.distanceKm - b.distanceKm;
    };

    const chosen = free.sort(rank)[0] || shareable.sort(rank)[0] || null;
    return chosen ? { ...chosen, partnerId: chosen.partner._id } : null;
}

/** Whether this seller runs riders of their own at all. */
export async function sellerHasOwnFleet(restaurantId) {
    if (!restaurantId || !mongoose.Types.ObjectId.isValid(String(restaurantId))) return false;
    const count = await FoodDeliveryPartner.countDocuments({
        restaurantId: new mongoose.Types.ObjectId(String(restaurantId))
    });
    return count > 0;
}
