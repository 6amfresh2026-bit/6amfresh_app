import mongoose from 'mongoose';

import { FoodOrder } from '../models/order.model.js';
import { logger } from '../../../../utils/logger.js';
import { haversineKm as geoHaversineKm, parseGeoPoint, formatDeliveryAddress } from '../../shared/geo.utils.js';
import {
  notifyOwnersActionableAlert,
  sendNotificationToOwner,
  sendNotificationToOwners,
} from "../../../../core/notifications/firebase.service.js";
import { getIO, rooms } from '../../../../config/socket.js';
import { addOrderJob } from '../../../../queues/producers/order.producer.js';
import { resolveOrderPromise } from '../helpers/promise.util.js';

export function enqueueOrderEvent(action, payload = {}) {
  try {
    void addOrderJob({ action, ...payload }).catch((err) => {
      logger.warn(`BullMQ enqueue order event failed: ${action} - ${err?.message || err}`);
    });
  } catch (err) {
    logger.warn(`BullMQ enqueue order event failed (sync): ${action} - ${err?.message || err}`);
  }
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  return geoHaversineKm(lat1, lon1, lat2, lon2);
}

/**
 * Build a dialer URI the client can hand straight to url_launcher / Linking.
 * Strips spaces, dashes and brackets — a raw number with formatting won't dial.
 * Returns '' when there is no usable number, so the app can hide the call button.
 */
export function buildTelUri(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (digits.replace(/\D/g, '').length < 6) return '';
  return `tel:${digits}`;
}

export function generateFourDigitDeliveryOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export function sanitizeOrderForExternal(orderDoc) {
  const o = orderDoc?.toObject ? orderDoc.toObject() : { ...(orderDoc || {}) };
  delete o.deliveryOtp;
  const dv = o.deliveryVerification;
  if (dv && dv.dropOtp != null) {
    const d = dv.dropOtp;
    o.deliveryVerification = {
      ...dv,
      dropOtp: {
        required: Boolean(d.required),
        verified: Boolean(d.verified),
      },
    };
  }
  o.orderMongoId = (o._id || orderDoc?._id || "").toString();
  // Ensure orderId field for UI always contains the pretty ID
  o.orderId = o.order_id || o.orderMongoId; 
  o.items = describeDeliveredItems(o.items);
  return o;
}

/**
 * Restates order lines in terms of what is actually being delivered.
 *
 * Every screen — the rider's pickup list, the customer's order, the invoice —
 * renders `item.quantity`, and after a short pick that is the figure the
 * customer ASKED for, not the one going in the bag. Left alone, a rider
 * collects four of something when two are being sent, and an invoice shows
 * 4 × ₹149 against a bill charging for two, which simply does not add up.
 *
 * Done here, at the one boundary every read path already crosses, rather than
 * in each screen. Changing the model and then hunting the surfaces one by one
 * is how `scheduledAt` and `deliverySlot` went missing from half this system.
 *
 * `orderedQuantity` keeps what was asked for, so a screen that wants to show
 * "2 of 4 — the rest refunded" still can.
 */
function describeDeliveredItems(items) {
  if (!Array.isArray(items)) return items;
  return items
    .map((line) => {
      const adjusted = line?.fulfilledQuantity;
      if (adjusted === null || adjusted === undefined) return line;
      return {
        ...line,
        quantity: Math.max(0, Number(adjusted) || 0),
        orderedQuantity: Number(line.quantity) || 0,
        wasShortPicked: (Number(adjusted) || 0) < (Number(line.quantity) || 0),
      };
    })
    // A line the shelf could not supply at all is not part of the delivery.
    // It stays on the order itself for the record; it does not belong on a
    // picking list or a bill.
    .filter((line) => Number(line.quantity) > 0);
}

export function sanitizeOrderForDeliveryPartner(orderDoc) {
  const o = sanitizeOrderForExternal(orderDoc);
  const cookingNote = String(o.note || "").trim();
  const deliveryInstructions = String(o.deliveryInstructions || "").trim();
  return {
    ...o,
    cookingNote,
    deliveryInstructions,
    note: deliveryInstructions,
  };
}

export function emitDeliveryDropOtpToUser(order, plainOtp) {
  try {
    const io = getIO();
    if (!io || !plainOtp || !order?.userId) return;
    io.to(rooms.user(order.userId)).emit("delivery_drop_otp", {
      orderMongoId: order._id?.toString?.(),
      orderId: order.order_id || order._id?.toString?.(),
      otp: plainOtp,
      message:
        "Share this OTP with your delivery partner to hand over the order.",
    });
  } catch (e) {
    logger.warn(`emitDeliveryDropOtpToUser failed: ${e?.message || e}`);
  }
}

export async function notifyOwnersSafely(targets, payload) {
  try {
    await sendNotificationToOwners(targets, payload);
  } catch (error) {
    logger.warn(`FCM notification failed: ${error?.message || error}`);
  }
}

/** Re-exported so dispatch and the order helpers share one definition. */
export { notifyOwnersActionableAlert };

export async function notifyOwnerSafely(target, payload) {
  try {
    await sendNotificationToOwner({ ...target, payload });
  } catch (error) {
    logger.warn(`FCM notification failed: ${error?.message || error}`);
  }
}

export const TERMINAL_ORDER_STATUSES = [
  'delivered',
  'cancelled_by_user',
  'cancelled_by_restaurant',
  'cancelled_by_admin',
];

/**
 * The promise rules live in a leaf module because the order model's pre-save
 * hook settles them too, and the model cannot import this file without a cycle.
 */
export { buildOrderPromise } from '../helpers/promise.util.js';

/**
 * Closes an order's promise out, in place, once it stops moving.
 *
 * The model does this on save for every ordinary path; this is for the callers
 * that hold a document and want the settled figure back immediately.
 */
export function settleOrderPromise(order, { at = new Date(), status } = {}) {
  const current = order?.promise?.toObject?.() || order?.promise || {};
  const next = resolveOrderPromise(current, { at, status: status || order?.orderStatus });
  if (order) order.promise = next;
  return next;
}

/**
 * How many live orders one rider may carry at once.
 *
 * One was the old answer, and it is what makes the rider the most expensive
 * line in a quick-commerce order: two customers half a street apart, served by
 * two separate trips from the same store. Batching is the lever, but only
 * under the conditions in canPartnerTakeOrder() — a "batch" of two unrelated
 * pickups across town is just one late order plus another.
 */
export const MAX_ACTIVE_ORDERS_PER_RIDER = Math.max(
  1,
  Number(process.env.MAX_ORDERS_PER_RIDER) || 3,
);

/**
 * How far apart two drops may be and still ride together.
 *
 * The second customer pays for the first one's doorstep in minutes, and this
 * is the cap on that. Deliberately small: past roughly a kilometre and a half
 * the detour costs more promise than the trip saves.
 */
export const BATCH_DROP_RADIUS_KM = Math.max(
  0.1,
  Number(process.env.BATCH_DROP_RADIUS_KM) || 1.5,
);

const ACTIVE_DELIVERY_SELECT = '_id order_id restaurantId deliveryAddress deliveryState orderStatus promise payment pricing';

/** Every order a rider is currently carrying. */
export async function getActiveDeliveriesForPartner(deliveryPartnerId) {
  if (!deliveryPartnerId) return [];
  const partnerId = new mongoose.Types.ObjectId(deliveryPartnerId);
  return FoodOrder.find({
    'dispatch.deliveryPartnerId': partnerId,
    'dispatch.status': 'accepted',
    orderStatus: { $nin: TERMINAL_ORDER_STATUSES },
  })
    .select(ACTIVE_DELIVERY_SELECT)
    .lean();
}

export async function partnerHasActiveDelivery(deliveryPartnerId) {
  return (await getActiveDeliveriesForPartner(deliveryPartnerId)).length > 0;
}

const dropPointOf = (order) => {
  const coords = order?.deliveryAddress?.location?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lng, lat] = coords;
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
    ? { lat: Number(lat), lng: Number(lng) }
    : null;
};

/**
 * Whether a rider already carrying work may also take this order.
 *
 * Three conditions, and all of them are about protecting the promise rather
 * than about counting:
 *
 *  - **Same store.** A second pickup somewhere else is not a batch; it is two
 *    trips wearing one rider.
 *  - **Not yet collected.** Added while the rider is still heading to the
 *    store or standing in it, so one pickup serves the whole batch. Once they
 *    have ridden away, a new order means riding back.
 *  - **Drops close together.** The customer already on board pays for the new
 *    one's doorstep in minutes, and BATCH_DROP_RADIUS_KM is the cap on that.
 *
 * Returns a reason on refusal because the rider app shows it, and "you already
 * have an active delivery" was the single most useless sentence in that app.
 */
export function canPartnerTakeOrder(activeOrders, candidate) {
  const active = Array.isArray(activeOrders) ? activeOrders : [];
  if (active.length === 0) return { allowed: true, reason: '', activeCount: 0 };

  if (active.length >= MAX_ACTIVE_ORDERS_PER_RIDER) {
    return {
      allowed: false,
      activeCount: active.length,
      reason: `You are already carrying ${active.length} orders. Deliver one before taking another.`,
    };
  }

  const candidateStore = String(candidate?.restaurantId?._id || candidate?.restaurantId || '');
  const sameStore = active.every(
    (o) => String(o?.restaurantId?._id || o?.restaurantId || '') === candidateStore,
  );
  if (!candidateStore || !sameStore) {
    return {
      allowed: false,
      activeCount: active.length,
      reason: 'This order is from a different store. Finish your current pickup first.',
    };
  }

  const collected = active.some(
    (o) => Boolean(o?.deliveryState?.pickedUpAt) || ['picked_up', 'reached_drop'].includes(String(o?.orderStatus)),
  );
  if (collected) {
    return {
      allowed: false,
      activeCount: active.length,
      reason: 'You have already collected your current order. Deliver it before taking another.',
    };
  }

  const candidateDrop = dropPointOf(candidate);
  if (candidateDrop) {
    for (const existing of active) {
      const drop = dropPointOf(existing);
      // An address with no coordinates cannot be checked; letting it through
      // beats refusing every order in a shop whose customers have no pin.
      if (!drop) continue;
      const apart = geoHaversineKm(drop.lat, drop.lng, candidateDrop.lat, candidateDrop.lng);
      if (Number.isFinite(apart) && apart > BATCH_DROP_RADIUS_KM) {
        return {
          allowed: false,
          activeCount: active.length,
          reason: 'That drop is too far from the one you are already carrying.',
        };
      }
    }
  }

  return { allowed: true, reason: '', activeCount: active.length };
}

/**
 * Riders who cannot take another order at all, and what the rest are carrying.
 *
 * `busy` used to be every rider holding anything. It is now only those at
 * capacity — the rest are still candidates, and `loadByPartner` lets the
 * dispatcher prefer a rider already heading to this very store, which is the
 * cheapest rider there is.
 */
export async function getDeliveryPartnerLoads() {
  const rows = await FoodOrder.find({
    'dispatch.status': 'accepted',
    'dispatch.deliveryPartnerId': { $exists: true, $ne: null },
    orderStatus: { $nin: TERMINAL_ORDER_STATUSES },
  })
    .select('dispatch.deliveryPartnerId restaurantId deliveryState orderStatus')
    .lean();

  const loadByPartner = new Map();
  for (const row of rows) {
    const key = String(row.dispatch.deliveryPartnerId);
    const entry = loadByPartner.get(key) || { count: 0, restaurantIds: new Set(), collected: false };
    entry.count += 1;
    entry.restaurantIds.add(String(row.restaurantId || ''));
    if (row?.deliveryState?.pickedUpAt || ['picked_up', 'reached_drop'].includes(String(row.orderStatus))) {
      entry.collected = true;
    }
    loadByPartner.set(key, entry);
  }

  const atCapacity = new Set(
    [...loadByPartner.entries()]
      .filter(([, e]) => e.count >= MAX_ACTIVE_ORDERS_PER_RIDER || e.collected)
      .map(([key]) => key),
  );

  return { loadByPartner, atCapacity };
}

/** Kept for callers that only ever wanted "cannot take anything more". */
export async function getBusyDeliveryPartnerIds() {
  return (await getDeliveryPartnerLoads()).atCapacity;
}

export function buildOrderIdentityFilter(orderIdOrMongoId) {
  const raw = String(orderIdOrMongoId || "").trim();
  if (!raw) return null;
  if (mongoose.isValidObjectId(raw))
    return { _id: new mongoose.Types.ObjectId(raw) };
  
  // Search BOTH underscore and camelCase variants for robust lookup
  return { 
    $or: [
        { order_id: raw },
        { orderId: raw }
    ]
  };
}

export function toGeoPoint(lat, lng) {
  if (lat == null || lng == null) return undefined;
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return { type: "Point", coordinates: [b, a] };
}

export function pushStatusHistory(order, { byRole, byId, from, to, note = "" }) {
  order.statusHistory.push({
    at: new Date(),
    byRole,
    byId: byId || undefined,
    from,
    to,
    note,
  });
}

export function normalizeOrderForClient(orderDoc) {
  const order = orderDoc?.toObject ? orderDoc.toObject() : orderDoc || {};
  const mongoId = (order._id || orderDoc?._id || "").toString();
  const displayId = order.order_id || mongoId;
  const statusHistory = Array.isArray(order?.statusHistory)
    ? order.statusHistory
    : [];
  const cancellationEntry = [...statusHistory]
    .reverse()
    .find((entry) => String(entry?.to || "").toLowerCase().includes("cancel"));
  const cancellationReason =
    String(order?.cancellationReason || "").trim() ||
    String(cancellationEntry?.note || "").trim();
  const cancellationStatus = String(cancellationEntry?.to || "").toLowerCase();
  let cancelledBy = "";
  if (cancellationStatus === "cancelled_by_user") cancelledBy = "customer";
  else if (cancellationStatus === "cancelled_by_restaurant")
    cancelledBy = "restaurant";
  else if (cancellationStatus === "cancelled_by_admin") cancelledBy = "admin";
  else if (String(cancellationEntry?.byRole || "").toUpperCase() === "USER")
    cancelledBy = "customer";
  else if (
    String(cancellationEntry?.byRole || "").toUpperCase() === "RESTAURANT"
  )
    cancelledBy = "restaurant";
  else if (String(cancellationEntry?.byRole || "").toUpperCase() === "ADMIN")
    cancelledBy = "admin";

  return {
    ...order,
    // The other client-facing serializer does this too. Both, because both are
    // real read paths — sanitizeOrderForExternal feeds the rider and the order
    // lists, this one feeds the customer's order screen and its invoice, and
    // fixing one of the two is how a line total of 4 x 149 ended up printed on
    // a bill charging for two.
    items: describeDeliveredItems(order.items),
    orderMongoId: mongoId,
    orderId: displayId,
    status: order?.orderStatus || order?.status || "",
    cancellationReason,
    cancelledBy,
    cancelledAt: cancellationEntry?.at || null,
    deliveredAt:
      order?.deliveryState?.deliveredAt || order?.deliveredAt || null,
    deliveryPartnerId:
      order?.dispatch?.deliveryPartnerId || order?.deliveryPartnerId || null,
    rating: order?.ratings?.restaurant?.rating ?? order?.rating ?? null,
    deliveryState: {
      ...(order?.deliveryState || {}),
      currentLocation: order?.lastRiderLocation?.coordinates?.length >= 2 ? {
        lat: order.lastRiderLocation.coordinates[1],
        lng: order.lastRiderLocation.coordinates[0]
      } : (order?.deliveryState?.currentLocation || null)
    },
    eta: buildLiveEta(order)
  };
}

/** Straight-line km inflated to approximate road distance for city driving. */
const ROAD_FACTOR = 1.3;
/** Average city delivery speed (km/h) — bikes in traffic. */
export const AVG_SPEED_KMPH = 22;
/**
 * Minutes the seller spends picking and packing before a rider can leave.
 *
 * The customer-facing countdown was pure rider travel time, which is only the
 * truth once the order is already in a bag. Quoting travel alone means every
 * order reads late from the moment it is placed.
 *
 * ponytail: one flat number for every seller. Derive it per seller from their
 * own accept-to-ready times once there is enough history to be worth trusting.
 */
export const PACKING_MINUTES = Number(process.env.PACKING_MINUTES) || 3;

/**
 * What one extra drop costs the customers behind it.
 *
 * Handing an order over is not instant — finding the door, the flat, the OTP.
 * Batching only pays if this is small, and it is the number that decides
 * whether a batched customer is quoted honestly or optimistically.
 */
export const PER_DROP_MINUTES = Number(process.env.PER_DROP_MINUTES) || 4;

/**
 * How long before a booked window the order becomes work: when the dispatcher
 * starts hunting a rider, and the earliest the rider's own offer list shows it.
 *
 * This is quick commerce, not restaurant delivery. The whole promise is packing
 * overlapped with a short ride to the seller, then a short ride to the door —
 * minutes, not half an hour. So the lead is derived from the same constants as
 * the promise itself: packing against the ride across the first dispatch band,
 * whichever is longer, plus a little slack for the hunt to actually find
 * somebody. A flat half hour would have pulled riders off the morning rush to
 * stand waiting for an order that takes ten minutes to run.
 */
const FIRST_DISPATCH_BAND_KM = Number(process.env.DISPATCH_FIRST_BAND_KM) || 3;
const HUNT_SLACK_MINUTES = 2;

export const DISPATCH_LEAD_MINUTES =
    Number(process.env.DISPATCH_LEAD_MINUTES) ||
    Math.ceil(
        Math.max(PACKING_MINUTES, (FIRST_DISPATCH_BAND_KM / AVG_SPEED_KMPH) * 60) + HUNT_SLACK_MINUTES
    );

export const DISPATCH_LEAD_MS = DISPATCH_LEAD_MINUTES * 60 * 1000;

/**
 * How long before a window ordering for it stops, unless the admin says otherwise.
 *
 * This is the store's picking lead, not a delivery-speed number — but in quick
 * commerce it should still be minutes. An hour, the old default, meant a
 * customer could not order at 06:30 for a 07:00 round, which is precisely the
 * order this business exists to take.
 *
 * Long enough to pick the batch and have the dispatcher already hunting when
 * the window opens: the dispatch lead, plus one more packing slot for the
 * batch, rounded to a number a human would choose.
 */
export const DEFAULT_SLOT_CUTOFF_MINUTES =
    Number(process.env.SLOT_CUTOFF_MINUTES) ||
    Math.ceil((DISPATCH_LEAD_MINUTES + PACKING_MINUTES) / 5) * 5;

/**
 * How far out the dispatcher will look, attempt by attempt.
 *
 * Quick commerce bands: a rider 40 km away cannot serve a promise measured in
 * minutes, so offering to them mostly delays the escalation that would have got
 * the order delivered.
 */
export const dispatchRadiusBandsKm = () => {
    const parsed = String(process.env.DISPATCH_RADIUS_BANDS_KM || '3,5,8,12')
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0);
    return parsed.length > 0 ? parsed : [3, 5, 8, 12];
};

/**
 * How far out a rider browsing for work is shown orders.
 *
 * A shade wider than the furthest the dispatcher itself will go, so a rider can
 * still take something just outside the last escalation — but not so wide that
 * the list fills with orders they could never serve in time. Derived from the
 * bands, because it was once a flat 20 km explained as "slightly wider than
 * dispatch (15 km)", and stayed there after the bands dropped to 3/5/8/12.
 */
export const maxOfferKm = () => {
    const bands = dispatchRadiusBandsKm();
    return Math.round(bands[bands.length - 1] * 1.25);
};

/**
 * Live ETA derived from the rider's last known position, recomputed on every read.
 *
 * Deliberately NOT a Directions API call: this is read on every order fetch and poll, so a
 * paid call here would be billed per refresh. Accuracy is "good enough for a countdown";
 * `source` tells the client what it is looking at.
 */
export function buildLiveEta(order) {
  const status = String(order?.orderStatus || '');
  if (['delivered', 'cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin'].includes(status)) {
    return { minutes: null, distanceKm: null, source: 'completed', target: null };
  }

  const rider = order?.lastRiderLocation?.coordinates?.length >= 2
    ? { lat: order.lastRiderLocation.coordinates[1], lng: order.lastRiderLocation.coordinates[0] }
    : null;

  const pickedUp = Boolean(order?.deliveryState?.pickedUpAt) || ['picked_up', 'reached_drop'].includes(status);
  // Before pickup the rider is heading to the restaurant; after, to the customer.
  const dest = pickedUp ? parseGeoPoint(order?.deliveryAddress) : parseGeoPoint(order?.restaurantId);
  const target = pickedUp ? 'customer' : 'restaurant';

  if (rider && dest) {
    const straight = geoHaversineKm(rider.lat, rider.lng, dest.lat, dest.lng);
    if (Number.isFinite(straight)) {
      const km = Number((straight * ROAD_FACTOR).toFixed(2));
      const minutes = Math.max(1, Math.ceil((km / AVG_SPEED_KMPH) * 60));
      return {
        minutes,
        distanceKm: km,
        source: 'live',
        target,
        promiseMinutes: buildDeliveryPromise(order, { minutes, pickedUp, status })
      };
    }
  }

  // No rider fix yet — fall back to the trip estimate captured at order time.
  const fallback = Number(order?.tripDurationMins ?? order?.pricing?.roadDurationMins);
  if (Number.isFinite(fallback) && fallback > 0) {
    return {
      minutes: Math.ceil(fallback),
      distanceKm: Number(order?.tripDistanceKm ?? order?.pricing?.roadDistanceKm) || null,
      source: 'estimate',
      target,
      promiseMinutes: buildDeliveryPromise(order, { minutes: null, pickedUp, status })
    };
  }

  return {
    minutes: null,
    distanceKm: null,
    source: 'unavailable',
    target,
    promiseMinutes: buildDeliveryPromise(order, { minutes: null, pickedUp, status })
  };
}

/**
 * Minutes until the customer has the order, as opposed to minutes until the
 * rider reaches wherever they are currently heading.
 *
 * `minutes` above answers the rider's question and is what the map needs. It is
 * the wrong number to show a customer before pickup, because it counts a leg
 * that ends at the seller's counter. The promise is what is still to happen:
 * packing, the ride to the seller, then the ride to the door -- with the first
 * two overlapping, since a rider travelling while the order is packed costs
 * whichever of the two is longer, not both.
 */
function buildDeliveryPromise(order, { minutes, pickedUp, status }) {
  // Once the rider has the bag, the remaining wait is just their journey.
  if (pickedUp) return Number.isFinite(minutes) ? minutes : null;

  const legToCustomer = Number(order?.pricing?.roadDurationMins ?? order?.tripDurationMins);
  if (!Number.isFinite(legToCustomer) || legToCustomer <= 0) return null;

  const alreadyPacked = ['ready_for_pickup', 'reached_pickup'].includes(String(status));
  const packing = alreadyPacked ? 0 : PACKING_MINUTES;
  const legToSeller = Number.isFinite(minutes) ? minutes : 0;

  return Math.ceil(Math.max(packing, legToSeller) + legToCustomer);
}

export async function applyAggregateRating(model, entityId, newRating) {
  if (!entityId) return;
  const doc = await model.findById(entityId).select("rating totalRatings");
  if (!doc) return;

  const totalRatings = Number(doc.totalRatings || 0);
  const currentAverage = Number(doc.rating || 0);
  const nextTotal = totalRatings + 1;
  const nextAverage = Number(
    ((currentAverage * totalRatings + Number(newRating)) / nextTotal).toFixed(1),
  );

  doc.totalRatings = nextTotal;
  doc.rating = nextAverage;
  await doc.save();
}

export function buildDeliverySocketPayload(orderDoc, restaurantDoc = null) {
  const order = orderDoc?.toObject ? orderDoc.toObject() : orderDoc || {};
  const restaurant = restaurantDoc || order?.restaurantId || null;
  const restaurantLocation = restaurant?.location || {};
  const deliveryAddress = order?.deliveryAddress || {};
  const customerAddress = formatDeliveryAddress(deliveryAddress);

  // Prefer robust geo parse (GeoJSON [lng,lat], lat/lng, nested location)
  const restaurantPoint =
    parseGeoPoint(restaurant) ||
    parseGeoPoint(restaurantLocation) ||
    parseGeoPoint({
      lat: restaurantLocation?.latitude ?? restaurantLocation?.lat,
      lng: restaurantLocation?.longitude ?? restaurantLocation?.lng,
    });
  const customerPoint =
    parseGeoPoint(deliveryAddress) ||
    parseGeoPoint(order?.customerLocation) ||
    parseGeoPoint({
      lat: deliveryAddress?.latitude ?? deliveryAddress?.lat,
      lng: deliveryAddress?.longitude ?? deliveryAddress?.lng,
    });

  const restaurantLat = restaurantPoint?.lat;
  const restaurantLng = restaurantPoint?.lng;
  const customerLat = customerPoint?.lat;
  const customerLng = customerPoint?.lng;

  // Prefer road distance when already computed; fall back to pricing Haversine.
  // Never use pickupDistanceKm (rider → restaurant) here — this is restaurant ↔ customer.
  const tripDistanceKmRaw =
    order?.tripDistanceKm ??
    order?.pricing?.roadDistanceKm ??
    order?.pricing?.distanceKm;
  let tripDistanceKm = Number.isFinite(Number(tripDistanceKmRaw))
    ? Number(Number(tripDistanceKmRaw).toFixed(2))
    : null;

  // If still missing, compute Haversine restaurant → customer so UI never shows blank/wrong.
  if (
    tripDistanceKm == null &&
    Number.isFinite(restaurantLat) &&
    Number.isFinite(restaurantLng) &&
    Number.isFinite(customerLat) &&
    Number.isFinite(customerLng)
  ) {
    const hv = haversineKm(restaurantLat, restaurantLng, customerLat, customerLng);
    if (Number.isFinite(hv)) {
      tripDistanceKm = Number(Number(hv).toFixed(2));
    }
  }

  const tripDurationMinsRaw =
    order?.tripDurationMins ?? order?.pricing?.roadDurationMins;
  let tripDurationMins = Number.isFinite(Number(tripDurationMinsRaw))
    ? Math.ceil(Number(tripDurationMinsRaw))
    : null;
  if (tripDurationMins == null && tripDistanceKm != null) {
    // ~25 km/h urban delivery average → minutes
    tripDurationMins = Math.max(1, Math.ceil((tripDistanceKm * 60) / 25));
  }

  console.log(`[DEBUG] buildDeliverySocketPayload - Order: ${order?.orderId || order?._id}`);
  console.log(`[DEBUG] buildDeliverySocketPayload - riderEarning in doc: ${order?.riderEarning}`);
  console.log(`[DEBUG] buildDeliverySocketPayload - deliveryFee in doc: ${order?.pricing?.deliveryFee}`);

  return {
    orderMongoId:
      orderDoc?._id?.toString?.() || order?._id?.toString?.() || order?._id,
    orderId: order?.order_id || order?._id?.toString?.(),
    status: orderDoc?.orderStatus || order?.orderStatus,
    items: order?.items || [],
    pricing: order?.pricing,
    total: order?.pricing?.total,
    payment: order?.payment,
    paymentMethod: order?.payment?.method,
    restaurantId:
      order?.restaurantId?._id?.toString?.() ||
      order?.restaurantId?.toString?.() ||
      order?.restaurantId,
    restaurantName: restaurant?.restaurantName || order?.restaurantName,
    restaurantAddress:
      restaurantLocation?.address ||
      restaurantLocation?.formattedAddress ||
      restaurant?.addressLine1 ||
      "",
    restaurantPhone: restaurant?.phone || restaurant?.ownerPhone || "",
    // Ready-to-launch dialer URI — the app can pass this straight to url_launcher.
    restaurantCallUri: buildTelUri(restaurant?.phone || restaurant?.ownerPhone),
    // Photos of the premises so the rider can recognise the shop on arrival.
    restaurantCoverImage:
      restaurant?.coverImage || (Array.isArray(restaurant?.coverImages) ? restaurant.coverImages[0] : '') || '',
    restaurantGalleryImages: Array.isArray(restaurant?.galleryImages) ? restaurant.galleryImages : [],
    restaurantLandmark: restaurant?.landmark || "",
    restaurantLocation: {
      latitude: Number.isFinite(restaurantLat) ? restaurantLat : undefined,
      longitude: Number.isFinite(restaurantLng) ? restaurantLng : undefined,
      lat: Number.isFinite(restaurantLat) ? restaurantLat : undefined,
      lng: Number.isFinite(restaurantLng) ? restaurantLng : undefined,
      coordinates:
        Number.isFinite(restaurantLat) && Number.isFinite(restaurantLng)
          ? [restaurantLng, restaurantLat]
          : undefined,
      address:
        restaurantLocation?.address ||
        restaurantLocation?.formattedAddress ||
        restaurant?.addressLine1 ||
        "",
      area: restaurantLocation?.area || restaurant?.area || "",
      city: restaurantLocation?.city || restaurant?.city || "",
      state: restaurantLocation?.state || restaurant?.state || "",
    },
    deliveryAddress: order?.deliveryAddress,
    customerLocation: {
      latitude: Number.isFinite(customerLat) ? customerLat : undefined,
      longitude: Number.isFinite(customerLng) ? customerLng : undefined,
      lat: Number.isFinite(customerLat) ? customerLat : undefined,
      lng: Number.isFinite(customerLng) ? customerLng : undefined,
      coordinates:
        Number.isFinite(customerLat) && Number.isFinite(customerLng)
          ? [customerLng, customerLat]
          : undefined,
    },
    // Restaurant ↔ customer trip distance (NOT rider pickup distance)
    tripDistanceKm,
    tripDurationMins,
    distanceKm: tripDistanceKm,
    customerAddress,
    customerName: order?.customerName || order?.deliveryAddress?.fullName || order?.deliveryAddress?.name || order?.userId?.name || "",
    customerPhone: order?.customerPhone || order?.deliveryAddress?.phone || order?.userId?.phone || "",
    customerCallUri: buildTelUri(
      order?.customerPhone || order?.deliveryAddress?.phone || order?.userId?.phone,
    ),
    userName: order?.customerName || order?.deliveryAddress?.fullName || order?.deliveryAddress?.name || order?.userId?.name || "",
    userPhone: order?.customerPhone || order?.deliveryAddress?.phone || order?.userId?.phone || "",
    note: order?.deliveryInstructions || "",
    cookingNote: order?.note || "",
    deliveryInstructions: order?.deliveryInstructions || "",
    riderEarning: order?.riderEarning || 0,
    earnings: order?.riderEarning || order?.pricing?.deliveryFee || 0,
    deliveryFee: order?.pricing?.deliveryFee || 0,
    deliveryFleet: order?.deliveryFleet,
    dispatch: order?.dispatch,
    createdAt: order?.createdAt,
    updatedAt: order?.updatedAt,
  };
}

export function canExposeOrderToRestaurant(orderLike) {
  if (String(orderLike?.orderStatus || "").toLowerCase() === "pending_payment") return false;
  const method = String(orderLike?.payment?.method || "").toLowerCase();
  const status = String(orderLike?.payment?.status || "").toLowerCase();
  // razorpay_qr is a pay-at-delivery flow like cash: the rider collects via QR at the
  // door, so the restaurant must see and prepare it even though nothing is captured yet.
  // Omitting it hid those orders from the restaurant list while still dispatching them,
  // so they silently auto-cancelled at the acceptance deadline.
  if (["cash", "wallet", "razorpay_qr"].includes(method)) return true;
  return ["paid", "authorized", "captured", "settled"].includes(status);
}

export async function notifyRestaurantNewOrder(orderDoc) {
  try {
    if (!orderDoc || !canExposeOrderToRestaurant(orderDoc)) return;

    const io = getIO();
    if (io) {
      const payload = {
        ...orderDoc.toObject(),
        orderMongoId: orderDoc._id?.toString?.() || undefined,
        orderId: orderDoc.order_id || orderDoc._id?.toString?.(),
      };
      logger.info(
        `[RestaurantOrders] Emitting new_order to ${rooms.restaurant(orderDoc.restaurantId)} for order ${orderDoc._id?.toString?.() || ''}`,
      );
      io.to(rooms.restaurant(orderDoc.restaurantId)).emit("new_order", payload);
    }

    // Atomic claim: only the caller that flips restaurantNotifiedAt from null actually
    // sends the push. Mongo guarantees a single winner even under a concurrent race, so a
    // retried webhook or duplicate code path can never ring the restaurant twice. The
    // socket emit above stays unguarded — it is just a UI refresh and is idempotent.
    const claimed = await FoodOrder.findOneAndUpdate(
      { _id: orderDoc._id, restaurantNotifiedAt: null },
      { $set: { restaurantNotifiedAt: new Date() } },
    );
    if (!claimed) return;

    const str = (v) => (v === undefined || v === null ? "" : String(v));
    const itemCount = Array.isArray(orderDoc.items)
      ? orderDoc.items.reduce((sum, it) => sum + (Number(it?.quantity) || 0), 0)
      : 0;
    const itemsList = Array.isArray(orderDoc.items)
      ? orderDoc.items.map((it) => `${it.quantity}x ${it.name}`).join(", ")
      : "";
    // deliveryAddressSchema has street/additionalDetails/city — there is no `address`
    // or `area` field on it, so reading those yielded undefined and the restaurant
    // only ever saw the city.
    const addressStr = formatDeliveryAddress(orderDoc.deliveryAddress);
    const total = orderDoc.pricing?.total ?? 0;
    
    // Construct rich body for the custom notification layout in Flutter
    let bodyText = `Order #${orderDoc.order_id || orderDoc._id} is waiting for review.`;
    if (itemsList) bodyText += `\nItems: ${itemsList}`;
    if (total > 0) bodyText += `\nTotal: ₹${total}`;
    if (orderDoc.customerName) bodyText += `\nCustomer: ${orderDoc.customerName}`;
    if (addressStr) bodyText += `\nAddress: ${addressStr}`;

    // Two messages, not one — see notifyOwnersActionableAlert.
    //
    // Accept/Reject can only be attached by the app itself, and the app is only
    // called for a data-only message. Blending both into a single message with a
    // notification block silently removed the buttons, because Android renders
    // such a message and never wakes the handler that would have added them.
    await notifyOwnersActionableAlert(
      [{ ownerType: "RESTAURANT", ownerId: orderDoc.restaurantId }],
      {
        title: "New order received",
        body: bodyText,
        androidTag: `order_${orderDoc._id?.toString?.() || ""}`,
        // The channel the restaurant app actually creates. The service default
        // is the rider app's new-order channel, which does not exist here —
        // Android silently demotes an unknown channel to low importance, so the
        // alert would arrive without sound or a heads-up even once it displayed.
        androidChannelId: "new_order_channel",
        data: {
          type: "new_order",
          title: "New order received",
          body: bodyText,
          orderId: orderDoc._id.toString(),
          orderMongoId: orderDoc._id?.toString?.() || "",
          orderDisplayId: str(orderDoc.order_id || orderDoc._id),
          link: `/restaurant/orders/${orderDoc._id?.toString?.() || ""}`,
          // Everything the notification needs to render without a follow-up API
          // call, which matters when the device is locked or the app was killed.
          customerName: str(orderDoc.customerName),
          itemCount: str(itemCount),
          itemsList: str(itemsList),
          address: str(addressStr),
          total: str(total),
          paymentMethod: str(orderDoc.payment?.method),
          acceptanceDeadlineAt: str(orderDoc.acceptanceDeadlineAt?.toISOString?.() || ""),
        },
      },
    );
  } catch {
    // Do not block order/payment flow if notification fails.
  }
}

export const CANCELLED_ORDER_STATUSES = [
  "cancelled_by_user",
  "cancelled_by_restaurant",
  "cancelled_by_admin",
];

export const normalizeOrderStatusValue = (value) => {
  const status = String(value || "").trim().toLowerCase();
  if (!status) return "";
  return status.replace(/^canceled/, "cancelled");
};

export const isCancelledOrderStatus = (value) => {
  const status = normalizeOrderStatusValue(value);
  if (!status) return false;
  if (CANCELLED_ORDER_STATUSES.includes(status)) return true;
  if (status === "cancelled" || status === "canceled") return true;
  return status.startsWith("cancelled_by_") || status.startsWith("canceled_by_");
};

export const isCancelledOrder = (order) => {
  if (
    isCancelledOrderStatus(order?.orderStatus) ||
    isCancelledOrderStatus(order?.status)
  ) {
    return true;
  }

  const history = Array.isArray(order?.statusHistory) ? order.statusHistory : [];
  const cancellationEntry = [...history]
    .reverse()
    .find((entry) => String(entry?.to || "").toLowerCase().includes("cancel"));

  return Boolean(
    cancellationEntry && isCancelledOrderStatus(cancellationEntry.to),
  );
};

export const STATUS_PRIORITY = {
  created: 10,
  confirmed: 20,
  preparing: 30,
  ready_for_pickup: 40,
  reached_pickup: 50,
  picked_up: 60,
  reached_drop: 70,
  delivered: 80,
  cancelled_by_user: 100,
  cancelled_by_restaurant: 100,
  cancelled_by_admin: 100,
};

/**
 * Returns true if the next status is a valid forward progression from the current status.
 * Prevents "reversing" order status (e.g. from Preparing back to Created).
 */
export function isStatusAdvance(current, next) {
  // If current status is missing, it's effectively 'created' or start of flow
  if (!current) return true;
  
  const currentPrio = STATUS_PRIORITY[current] || 0;
  const nextPrio = STATUS_PRIORITY[next] || 0;

  // Terminal states (100) cannot transition to anything else
  if (currentPrio >= 100) return false;
  
  // Delivered (80) cannot transition to anything (except maybe cancellation if allowed, but here we say no)
  if (currentPrio === 80) return false;

  // Special case: Cancellation is almost always an advance unless already delivered
  if (nextPrio === 100 && currentPrio < 80) return true;

  return nextPrio > currentPrio;
}
