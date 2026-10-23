import mongoose from 'mongoose';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { FoodZone } from '../models/zone.model.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { attachOutletTimingsToRestaurants } from '../../restaurant/services/outletTimings.service.js';
import { getRestaurantAvailabilityStatus } from '../../restaurant/helpers/restaurantAvailability.helper.js';
import {
    CUSTOMER_MODES,
    DEFAULT_APP_WINDOW,
    DEFAULT_INSTANT_WINDOW,
    INSTANT_MODES,
    getAppStatus,
    hasAppTimings,
    normalizeAppTimings,
    toMinutes
} from '../../restaurant/helpers/appStatus.helper.js';

/**
 * Admin > App timings & store status.
 *
 * One row per approved store: what the admin has set, the till's live status, and what that adds up
 * to for customers right now (the same availability check the app and checkout use, so the chips
 * on the screen are never a guess).
 */

const MAX_LIMIT = 200;
const MESSAGE_MAX = 280;
const FIELDS =
    'restaurantName zoneId status isActive isAcceptingOrders openingTime closingTime openDays deliveryTimings appTimings posLastSeenAt';

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const objectId = (value, label) => {
    const v = String(value ?? '');
    if (!mongoose.Types.ObjectId.isValid(v)) throw new ValidationError(`Invalid ${label}`);
    return new mongoose.Types.ObjectId(v);
};

/** One store as the admin screen shows it. `withOutlet` is the doc with its outlet timings attached. */
const toRow = (withOutlet, zoneName, now) => {
    const config = normalizeAppTimings(withOutlet.appTimings);
    const app = getAppStatus(withOutlet, now);
    const availability = getRestaurantAvailabilityStatus(withOutlet, now);
    return {
        id: String(withOutlet._id),
        name: withOutlet.restaurantName || 'Store',
        zoneId: withOutlet.zoneId ? String(withOutlet.zoneId) : null,
        zoneName: zoneName || '',
        // What the form shows. Nothing saved yet means the usual windows are suggested, not enforced.
        config: {
            ...config,
            openTime: config.openTime || DEFAULT_APP_WINDOW.openTime,
            closeTime: config.closeTime || DEFAULT_APP_WINDOW.closeTime,
            instantFrom: config.instantFrom || DEFAULT_INSTANT_WINDOW.instantFrom,
            instantTo: config.instantTo || DEFAULT_INSTANT_WINDOW.instantTo
        },
        configured: hasAppTimings(withOutlet.appTimings),
        pos: {
            online: app.pos.online,
            lastSeenAt: app.pos.lastSeenAt,
            secondsAgo: app.pos.secondsAgo
        },
        // The verdicts customers actually get.
        customerOpen: availability.isOpen,
        reason: availability.reason,
        instantLive: availability.instantLive === true,
        isAcceptingOrders: availability.isAcceptingOrders,
        isActive: availability.isActive
    };
};

const zoneNames = async (docs) => {
    const ids = [...new Set(docs.map((d) => String(d.zoneId || '')).filter(Boolean))];
    if (!ids.length) return new Map();
    const zones = await FoodZone.find({ _id: { $in: ids } }).select('name zoneName').lean();
    return new Map(zones.map((z) => [String(z._id), z.name || z.zoneName || '']));
};

export async function listAppTimings(query = {}) {
    const now = new Date();
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), MAX_LIMIT);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);

    const match = { status: 'approved' };
    if (query.zoneId) match.zoneId = objectId(query.zoneId, 'zone');
    if (query.search && String(query.search).trim()) {
        match.restaurantName = { $regex: escapeRegex(String(query.search).trim()), $options: 'i' };
    }

    const [total, docs] = await Promise.all([
        FoodRestaurant.countDocuments(match),
        FoodRestaurant.find(match)
            .select(FIELDS)
            .sort({ restaurantName: 1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean()
    ]);

    const [withOutlet, zones] = await Promise.all([
        attachOutletTimingsToRestaurants(docs, { useDefaults: false }),
        zoneNames(docs)
    ]);
    const stores = withOutlet.map((d) => toRow(d, zones.get(String(d.zoneId || '')), now));

    return {
        stores,
        total,
        page,
        limit,
        serverTime: now.toISOString(),
        // Counts for the stores on this page: what the chips add up to.
        summary: {
            shown: stores.length,
            posOnline: stores.filter((s) => s.pos.online).length,
            customerOpen: stores.filter((s) => s.customerOpen).length,
            instantLive: stores.filter((s) => s.instantLive).length
        }
    };
}

const cleanTime = (value, label) => {
    if (value === '' || value === null) return '';
    if (toMinutes(value) === null) throw new ValidationError(`${label} must be a time like 06:00`);
    return String(value).trim();
};

/** Both ends of a window or neither: half a window would silently mean "no window". */
const checkPair = (from, to, label) => {
    if (Boolean(from) !== Boolean(to)) throw new ValidationError(`Set both the ${label} start and end time, or leave both empty`);
};

/**
 * Saves the admin's settings for one store. Only the fields that are sent are changed.
 * Returns the store's row as the list shows it.
 */
export async function saveAppTimings(restaurantId, body = {}, adminId = null) {
    const id = objectId(restaurantId, 'store');
    const existing = await FoodRestaurant.findById(id).select(FIELDS).lean();
    if (!existing || existing.status !== 'approved') throw new NotFoundError('Store not found');

    const current = normalizeAppTimings(existing.appTimings);
    const next = { ...current };

    if (body.customerMode !== undefined) {
        if (!CUSTOMER_MODES.includes(body.customerMode)) throw new ValidationError('Customer app must be follow, open or closed');
        next.customerMode = body.customerMode;
    }
    if (body.instantMode !== undefined) {
        if (!INSTANT_MODES.includes(body.instantMode)) throw new ValidationError('Instant delivery must be follow, on or off');
        next.instantMode = body.instantMode;
    }
    if (body.openTime !== undefined) next.openTime = cleanTime(body.openTime, 'Open time');
    if (body.closeTime !== undefined) next.closeTime = cleanTime(body.closeTime, 'Close time');
    if (body.instantFrom !== undefined) next.instantFrom = cleanTime(body.instantFrom, 'Instant start time');
    if (body.instantTo !== undefined) next.instantTo = cleanTime(body.instantTo, 'Instant end time');
    if (body.closedMessage !== undefined) {
        const message = String(body.closedMessage ?? '').trim();
        if (message.length > MESSAGE_MAX) throw new ValidationError(`The closed message can be at most ${MESSAGE_MAX} characters`);
        next.closedMessage = message;
    }
    if (body.requirePosOnline !== undefined) {
        if (typeof body.requirePosOnline !== 'boolean') throw new ValidationError('Require POS online must be true or false');
        next.requirePosOnline = body.requirePosOnline;
    }

    checkPair(next.openTime, next.closeTime, 'open');
    checkPair(next.instantFrom, next.instantTo, 'instant');

    const now = new Date();
    await FoodRestaurant.updateOne(
        { _id: id },
        {
            $set: {
                'appTimings.customerMode': next.customerMode,
                'appTimings.openTime': next.openTime,
                'appTimings.closeTime': next.closeTime,
                'appTimings.instantMode': next.instantMode,
                'appTimings.instantFrom': next.instantFrom,
                'appTimings.instantTo': next.instantTo,
                'appTimings.closedMessage': next.closedMessage,
                'appTimings.requirePosOnline': next.requirePosOnline,
                'appTimings.updatedAt': now,
                ...(adminId && mongoose.Types.ObjectId.isValid(String(adminId)) ? { 'appTimings.updatedBy': adminId } : {})
            }
        }
    );

    const fresh = await FoodRestaurant.findById(id).select(FIELDS).lean();
    const [withOutlet] = await attachOutletTimingsToRestaurants([fresh], { useDefaults: false });
    const zones = await zoneNames([fresh]);
    return toRow(withOutlet, zones.get(String(fresh.zoneId || '')), now);
}
