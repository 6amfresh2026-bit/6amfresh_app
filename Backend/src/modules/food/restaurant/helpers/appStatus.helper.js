import { getRestaurantLocalTimeParts } from '../../../../utils/timezone.js';

/**
 * Whether a store is taking customer-app orders and instant delivery, as far as the ADMIN's
 * controls go (Admin > App timings & store status). The seller's own outlet timings and pause
 * switch are separate and are combined with this in restaurantAvailability.helper.js.
 *
 * Everything here is optional. A store whose admin has never touched these settings has no
 * window, no instant window and does not require the POS, so it is "open" as far as this file
 * is concerned and nothing changes for it.
 */

/**
 * The till checks in about every 20 s; this is how long it can be silent and still count as online.
 * Longer than a few missed beats on purpose: a browser slows a hidden tab's timers to roughly one a
 * minute, and a till that is merely in the background should not flicker offline.
 */
export const POS_ONLINE_WINDOW_MS = 90 * 1000;

/** What the admin screen shows before anything is saved. Never used to enforce anything. */
export const DEFAULT_APP_WINDOW = { openTime: '06:00', closeTime: '22:00' };
export const DEFAULT_INSTANT_WINDOW = { instantFrom: '07:00', instantTo: '21:00' };

export const CUSTOMER_MODES = ['follow', 'open', 'closed'];
export const INSTANT_MODES = ['follow', 'on', 'off'];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:mm" -> minutes after midnight, or null for anything else. */
export const toMinutes = (value) => {
    const m = HHMM.exec(String(value ?? '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Is `nowMinutes` inside from..to? A window that ends before it starts runs overnight
 * (22:00-02:00). Equal ends mean "all day". A missing end means there is no window, so always true.
 */
export const isWithinWindow = (nowMinutes, from, to) => {
    const a = toMinutes(from);
    const b = toMinutes(to);
    if (a === null || b === null || a === b) return true;
    return b > a ? nowMinutes >= a && nowMinutes < b : nowMinutes >= a || nowMinutes < b;
};

/** The saved settings with every field present and valid, so callers never test for undefined. */
export const normalizeAppTimings = (raw) => {
    const t = raw && typeof raw === 'object' ? raw : {};
    return {
        customerMode: CUSTOMER_MODES.includes(t.customerMode) ? t.customerMode : 'follow',
        openTime: toMinutes(t.openTime) === null ? '' : t.openTime,
        closeTime: toMinutes(t.closeTime) === null ? '' : t.closeTime,
        instantMode: INSTANT_MODES.includes(t.instantMode) ? t.instantMode : 'follow',
        instantFrom: toMinutes(t.instantFrom) === null ? '' : t.instantFrom,
        instantTo: toMinutes(t.instantTo) === null ? '' : t.instantTo,
        closedMessage: typeof t.closedMessage === 'string' ? t.closedMessage : '',
        requirePosOnline: t.requirePosOnline === true,
    };
};

/**
 * Has the admin ever saved settings for this store? Drives "using defaults" in the admin screen.
 *
 * Only the save stamps updatedAt. Looking at the fields themselves would always say yes: the schema's
 * defaults ("follow", "follow") are written into every store when it is created.
 */
export const hasAppTimings = (raw) => Boolean(raw && typeof raw === 'object' && raw.updatedAt);

/** Whether the till has checked in recently, and how long ago. */
export const getPosPresence = (restaurant, now = new Date()) => {
    const seen = restaurant?.posLastSeenAt ? new Date(restaurant.posLastSeenAt) : null;
    if (!seen || Number.isNaN(seen.getTime())) {
        return { online: false, lastSeenAt: null, secondsAgo: null };
    }
    const age = Math.max(0, now.getTime() - seen.getTime());
    return { online: age <= POS_ONLINE_WINDOW_MS, lastSeenAt: seen, secondsAgo: Math.floor(age / 1000) };
};

/**
 * The admin-side verdict for one store at one moment.
 *
 * customerOpen is the admin's gate only: not forced closed, inside the admin window when
 * following it, and the POS online when the store requires that. instantLive is the same gate
 * plus the instant setting. The caller folds in the seller's own schedule and pause.
 *
 * reason is one of: open, app-forced-closed, app-outside-hours, pos-offline.
 */
export const getAppStatus = (restaurant, now = new Date()) => {
    const config = normalizeAppTimings(restaurant?.appTimings);
    const pos = getPosPresence(restaurant, now);
    const { nowMinutes } = getRestaurantLocalTimeParts(now);

    const windowOpen =
        config.customerMode === 'open'
            ? true
            : config.customerMode === 'closed'
              ? false
              : isWithinWindow(nowMinutes, config.openTime, config.closeTime);
    const posOk = !config.requirePosOnline || pos.online;
    const customerOpen = windowOpen && posOk;

    const instantAllowed =
        config.instantMode === 'on'
            ? true
            : config.instantMode === 'off'
              ? false
              : isWithinWindow(nowMinutes, config.instantFrom, config.instantTo);

    let reason = 'open';
    if (config.customerMode === 'closed') reason = 'app-forced-closed';
    else if (!windowOpen) reason = 'app-outside-hours';
    else if (!posOk) reason = 'pos-offline';

    return {
        config,
        pos,
        windowOpen,
        posOk,
        customerOpen,
        instantAllowed,
        instantLive: customerOpen && instantAllowed,
        reason,
        closedMessage: config.closedMessage,
    };
};

/** The sentence a customer sees when the admin's gate has closed the store. */
export const closedNoticeFor = (status) => {
    if (status?.closedMessage) return status.closedMessage;
    return status?.reason === 'pos-offline'
        ? 'This store is not taking orders right now. Please try again later.'
        : 'Store is currently closed. Please try again later.';
};
