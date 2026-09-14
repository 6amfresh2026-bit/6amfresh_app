import { FoodOrder } from '../models/order.model.js';
import { FoodDeliveryPartner } from '../../delivery/models/deliveryPartner.model.js';
import { haversineKm, parseGeoPoint } from '../../shared/geo.utils.js';
import { getRedisClient } from '../../../../config/redis.js';
import { logger } from '../../../../utils/logger.js';
import { maxOfferKm, MAX_ACTIVE_ORDERS_PER_RIDER, TERMINAL_ORDER_STATUSES, DISPATCH_LEAD_MS } from './order.helpers.js';

/**
 * How busy a store is right now, in the two terms the promise needs.
 *
 * The quote used to be distance alone, which made it wrong in exactly the
 * conditions that matter: a busy evening, when the nearest free rider is
 * further away and already carrying someone else's basket. Both of those add
 * minutes, and a customer told "6 mins" while eleven orders queue ahead of
 * them is not being quoted, they are being misled.
 *
 * Cached briefly per store because /calculate runs on every cart change. The
 * window is short enough that a surge is reflected within seconds and long
 * enough that typing in the cart does not scan the rider table each keystroke.
 */

const CACHE_TTL_SECONDS = 20;
const CACHE_KEY = (restaurantId) => `dispatch:pressure:${restaurantId}:v1`;

/**
 * Ceiling on how many drops we will admit to being behind.
 *
 * A store with a stale backlog of forgotten orders would otherwise quote an
 * hour and drive every customer away. Past this, the honest answer is not a
 * bigger number but a closed store.
 */
const MAX_DROPS_AHEAD = 5;

/** Riders whose GPS is older than this are not candidates, matching dispatch. */
const STALE_GPS_MS = Number(process.env.DISPATCH_STALE_GPS_MS) || 45 * 60 * 1000;

const memoryCache = new Map();

const readCache = async (key) => {
  const redis = getRedisClient();
  if (redis?.isReady) {
    try {
      const raw = await redis.get(key);
      if (raw) return JSON.parse(raw);
    } catch {
      // A poisoned key must not take the quote down with it.
    }
  }
  const hit = memoryCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  return null;
};

const writeCache = async (key, value) => {
  const redis = getRedisClient();
  if (redis?.isReady) {
    try {
      await redis.set(key, JSON.stringify(value), { EX: CACHE_TTL_SECONDS });
      return;
    } catch {
      // Fall through to the in-process cache.
    }
  }
  // Bounded: one entry per store, and without Redis this map is the only
  // thing holding them. A platform with thousands of stores should not grow a
  // permanent object per store because Redis happened to be down.
  if (memoryCache.size > 500) {
    for (const [k, v] of memoryCache) {
      if (v.expires <= Date.now()) memoryCache.delete(k);
    }
    if (memoryCache.size > 500) memoryCache.clear();
  }
  memoryCache.set(key, { value, expires: Date.now() + CACHE_TTL_SECONDS * 1000 });
};

/**
 * `{ riderLegKm, dropsAhead }` for a store.
 *
 * `riderLegKm` is null when no rider can be located at all — the promise then
 * falls back to its old packing-only shape rather than inventing a distance.
 */
export async function getStoreDispatchPressure(restaurant) {
  const restaurantId = String(restaurant?._id || restaurant || '');
  if (!restaurantId) return { riderLegKm: null, dropsAhead: 0 };

  const cached = await readCache(CACHE_KEY(restaurantId));
  if (cached) return cached;

  const store = parseGeoPoint(restaurant);
  let result = { riderLegKm: null, dropsAhead: 0 };

  try {
    const [partners, liveOrders] = await Promise.all([
      FoodDeliveryPartner.find({ availabilityStatus: 'online', status: 'approved' })
        .select('_id lastLat lastLng lastLocationAt')
        .lean(),
      // Everything this store still owes a doorstep *now*: unassigned and
      // waiting for a rider, or accepted and not yet handed over.
      //
      // Two exclusions, both of which would otherwise make every other
      // customer's quote worse for no reason:
      //  - pending_payment is never dispatched at all, so an abandoned cart
      //    would queue in front of people who have actually paid;
      //  - a booking for tomorrow's round is not ahead of anybody today. Same
      //    lead-time rule the rider offer list uses, so the two agree about
      //    what counts as imminent.
      FoodOrder.find({
        restaurantId,
        orderStatus: { $nin: [...TERMINAL_ORDER_STATUSES, 'pending_payment'] },
        'deliveryState.deliveredAt': null,
        $or: [
          { scheduledAt: null },
          { scheduledAt: { $lte: new Date(Date.now() + DISPATCH_LEAD_MS) } },
        ],
      })
        .select('dispatch.deliveryPartnerId dispatch.status')
        .lean(),
    ]);

    const freshCutoff = Date.now() - STALE_GPS_MS;
    const reachable = [];
    if (store) {
      for (const p of partners) {
        if (!Number.isFinite(Number(p.lastLat)) || !Number.isFinite(Number(p.lastLng))) continue;
        if (p.lastLocationAt && new Date(p.lastLocationAt).getTime() < freshCutoff) continue;
        const km = haversineKm(Number(p.lastLat), Number(p.lastLng), store.lat, store.lng);
        if (Number.isFinite(km) && km <= maxOfferKm()) reachable.push({ id: String(p._id), km });
      }
      reachable.sort((a, b) => a.km - b.km);
    }

    // How many drops each reachable rider is already committed to, anywhere.
    const loadByPartner = new Map();
    for (const o of liveOrders) {
      const key = String(o?.dispatch?.deliveryPartnerId || '');
      if (!key || o?.dispatch?.status !== 'accepted') continue;
      loadByPartner.set(key, (loadByPartner.get(key) || 0) + 1);
    }

    const withRoom = reachable.filter((r) => (loadByPartner.get(r.id) || 0) < MAX_ACTIVE_ORDERS_PER_RIDER);
    const nearest = withRoom[0] || reachable[0] || null;

    const pendingDrops = liveOrders.length;

    // Spread the store's outstanding drops across the riders who can still take
    // work. With nobody free, every outstanding drop is genuinely ahead.
    const dropsAhead = withRoom.length > 0
      ? Math.floor(pendingDrops / withRoom.length)
      : pendingDrops;

    result = {
      riderLegKm: nearest ? Number(nearest.km.toFixed(2)) : null,
      dropsAhead: Math.min(MAX_DROPS_AHEAD, Math.max(0, dropsAhead)),
    };
  } catch (err) {
    // A quote that cannot measure the pressure is still a quote. Falling back
    // to the old shape beats failing checkout.
    logger.warn(`Dispatch pressure unavailable for store ${restaurantId}: ${err?.message || err}`);
  }

  await writeCache(CACHE_KEY(restaurantId), result);
  return result;
}
