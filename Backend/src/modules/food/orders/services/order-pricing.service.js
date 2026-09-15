import mongoose from 'mongoose';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { FoodFeeSettings } from '../../admin/models/feeSettings.model.js';
import { FoodOffer } from '../../admin/models/offer.model.js';
import { FoodUser } from '../../../../core/users/user.model.js';
import { evaluateCoupon, loadCouponCustomerFacts } from './coupon-eligibility.service.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
  calculateDistanceKm,
  normalizeDeliveryAddress,
  normalizeRestaurantLocation,
  parseGeoPoint,
} from '../../shared/geo.utils.js';
import { fetchDrivingRoute } from '../utils/googleMaps.js';
import { attachOutletTimingsToRestaurants } from '../../restaurant/services/outletTimings.service.js';
import { getRestaurantAvailabilityStatus } from '../../restaurant/helpers/restaurantAvailability.helper.js';
import { resolveOrderCartItems } from '../helpers/order-cart-items.helper.js';
import { AVG_SPEED_KMPH, PACKING_MINUTES, PER_DROP_MINUTES } from './order.helpers.js';
import { getStoreDispatchPressure } from './dispatch-pressure.service.js';

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** Fixed 18% GST on delivery fee (separate from item GST in fee settings). */
export const DELIVERY_FEE_GST_RATE = 0.18;

export function computeDeliveryFeeGst(deliveryFee) {
  const base = Math.max(0, Number(deliveryFee) || 0);
  if (base <= 0) return 0;
  return round2(base * DELIVERY_FEE_GST_RATE);
}

const applyDeliveryModePricing = (pricing, deliveryMode, quickSurcharge = 0) => {
  const surcharge = Math.max(0, Number(quickSurcharge) || 0);
  const mode = deliveryMode === 'quick' ? 'quick' : 'basic';
  if (mode !== 'quick' || surcharge <= 0) {
    return {
      ...pricing,
      deliveryMode: mode,
      quickDeliveryFee: 0,
    };
  }
  const platformFee = round2((Number(pricing.platformFee) || 0) + surcharge);
  const total = round2((Number(pricing.total) || 0) + surcharge);
  return {
    ...pricing,
    platformFee,
    total,
    deliveryMode: mode,
    quickDeliveryFee: surcharge,
  };
};

export async function loadRestaurantForOrdering(restaurantId) {
  if (!restaurantId || !mongoose.Types.ObjectId.isValid(String(restaurantId))) {
    throw new ValidationError('Store not found');
  }

  const doc = await FoodRestaurant.findById(restaurantId)
    .select(
      // autoAcceptOrders is read at order creation to decide whether the order
      // waits for a seller. Left out of this projection it is always undefined,
      // so the flag silently does nothing however it is set.
      //
      // deliveryRadiusKm is the same trap and was caught the same way: the
      // serviceability check reads it, and a radius that is not selected reads
      // as no radius, so every address is inside it.
      'status restaurantName zoneId deliveryRadiusKm location isAcceptingOrders autoAcceptOrders outsideHoursOverride openingTime closingTime openDays deliveryTimings isActive',
    )
    .lean();

  if (!doc) throw new ValidationError('Store not found');
  if (doc.status !== 'approved') throw new ValidationError('Store not available');

  const [withTimings] = await attachOutletTimingsToRestaurants([doc], {
    useDefaults: false,
  });
  if (withTimings?.location) {
    withTimings.location = normalizeRestaurantLocation(withTimings.location);
  }
  return withTimings;
}

export function assertRestaurantOpenForOrdering(restaurant, at = new Date()) {
  const availability = getRestaurantAvailabilityStatus(restaurant, at);
  if (availability.isOpen) return availability;

  if (availability.reason === 'not-accepting-orders') {
    throw new ValidationError('Store is currently offline. Please try again later.');
  }

  throw new ValidationError('Store is currently closed. Please try again later.');
}

/**
 * The operational half of the check above, without the clock.
 *
 * A delivery window the platform publishes is not measured against counter
 * hours — an early round exists precisely because the counter is shut then.
 * But a shop that has paused orders, or been switched off by the admin, is not
 * taking bookings for later either: being closed for the day has to stop a 7am
 * booking the same way it stops one for right now.
 */
export function assertRestaurantAcceptingOrders(restaurant) {
  const availability = getRestaurantAvailabilityStatus(restaurant);
  if (availability.isActive === false) {
    throw new ValidationError('Store is currently closed. Please try again later.');
  }
  if (availability.isAcceptingOrders === false) {
    throw new ValidationError('Store is currently offline. Please try again later.');
  }
  return availability;
}

/**
 * Single source of truth for restaurant ↔ customer trip distance.
 * Prefer Google driving/road km (matches delivery partner Rest→User UI);
 * fall back to Haversine when Directions is unavailable.
 */
export async function getDeliveryDistanceKm(restaurant, deliveryAddress) {
  const straightLineKm = calculateDistanceKm(restaurant, deliveryAddress);

  const restaurantPoint = parseGeoPoint(restaurant);
  const customerPoint = parseGeoPoint(deliveryAddress);
  if (!restaurantPoint || !customerPoint) {
    return straightLineKm;
  }

  try {
    const route = await fetchDrivingRoute(
      { lat: restaurantPoint.lat, lng: restaurantPoint.lng },
      { lat: customerPoint.lat, lng: customerPoint.lng },
    );
    if (route?.distanceKm != null && Number.isFinite(Number(route.distanceKm))) {
      return Number(route.distanceKm);
    }
  } catch {
    // Fall through to Haversine.
  }

  return straightLineKm;
}

// Single money-rounding rule (2 decimals) so preview and charged totals always match.

function resolveBaseDeliveryFee(feeSettings = {}) {
  const ranges = Array.isArray(feeSettings.deliveryFeeRanges)
    ? feeSettings.deliveryFeeRanges
    : [];
  const rangeFees = ranges
    .map((range) => Number(range?.fee))
    .filter((fee) => Number.isFinite(fee) && fee >= 0);

  const flat = Number(feeSettings.deliveryFee);
  const hasPositiveFlat = Number.isFinite(flat) && flat > 0;

  if (rangeFees.length > 0) {
    const minRangeFee = Math.min(...rangeFees);
    return hasPositiveFlat ? flat : minRangeFee;
  }

  return Number.isFinite(flat) && flat >= 0 ? flat : 0;
}

function matchFeeRange(ranges, distanceKm, pickValue) {
  if (!Array.isArray(ranges) || ranges.length === 0 || !Number.isFinite(distanceKm)) {
    return null;
  }

  const sorted = [...ranges].sort((a, b) => Number(a.min) - Number(b.min));
  for (let i = 0; i < sorted.length; i += 1) {
    const range = sorted[i] || {};
    const min = Number(range.min);
    const max = Number(range.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;

    const isLast = i === sorted.length - 1;
    const inRange = isLast
      ? distanceKm >= min && distanceKm <= max
      : distanceKm >= min && distanceKm < max;

    if (inRange) {
      const value = pickValue(range);
      return Number.isFinite(value) ? value : null;
    }
  }

  return null;
}

export async function loadActiveFeeSettings() {
  const feeDoc = await FoodFeeSettings.findOne({ isActive: { $ne: false } })
    .sort({ createdAt: -1 })
    .lean();

  return (
    feeDoc || {
      deliveryFee: 0,
      deliveryFeeRanges: [],
      platformFee: 0,
      gstRate: 0,
    }
  );
}

/**
 * The delivery promise quoted at checkout.
 *
 * Three things stand between the tap and the doorstep, and the quote used to
 * count only one of them:
 *
 *  - **Packing**, which runs while the rider is still on their way.
 *  - **The rider's ride to the store.** Omitted entirely before this, which
 *    made the promise systematically optimistic exactly when it mattered — a
 *    busy evening, when the nearest free rider is furthest away.
 *  - **Drops already ahead of this one.** Batching means the customer behind
 *    waits for the doorstep in front. Quoting as though they were alone is how
 *    a batching change quietly turns into a wall of late orders.
 *
 * Packing and the ride to the store overlap, so they are a max rather than a
 * sum. Everything else is sequential.
 *
 * Same speed and packing constants the live countdown uses, so a customer is
 * not quoted one number before ordering and shown a different one after.
 */
export function estimateDeliveryPromiseMinutes(distanceKm, { riderLegKm = null, dropsAhead = 0 } = {}) {
  // Number(null) is 0, so an unknown distance would otherwise quote the packing
  // time alone -- a confident promise built on a distance nobody measured.
  if (distanceKm === null || distanceKm === undefined || distanceKm === '') return null;
  const km = Number(distanceKm);
  if (!Number.isFinite(km) || km < 0) return null;

  const minutesFor = (d) => (Number(d) / AVG_SPEED_KMPH) * 60;

  // An unknown rider leg falls back to packing alone, which is the old
  // behaviour: better to keep the previous quote than to invent a distance.
  const toStore = Number.isFinite(Number(riderLegKm)) && Number(riderLegKm) >= 0 ? minutesFor(riderLegKm) : 0;
  const ahead = Math.max(0, Number(dropsAhead) || 0) * PER_DROP_MINUTES;

  return Math.ceil(Math.max(PACKING_MINUTES, toStore) + minutesFor(km) + ahead);
}

/**
 * GST across a basket whose lines can sit in different slabs.
 *
 * Groceries are taxed per product — flour at 0, biscuits at 18 — so charging
 * one rate on the whole basket is wrong in both directions depending on what
 * the customer bought. A line with no rate of its own falls back to the
 * order-wide rate, which makes this identical to the old single-rate maths for
 * any basket of items that predate per-product slabs.
 *
 * The discount reduces every line in proportion to its share of the basket,
 * because a basket-level coupon is not attributable to any one product.
 */
export function computeItemsTax(items = [], { subtotal = 0, discount = 0, fallbackRate = 0 } = {}) {
  if (!(subtotal > 0)) return 0;

  const taxableShare = Math.max(0, subtotal - discount) / subtotal;
  let tax = 0;

  for (const item of items) {
    // null and undefined mean "no slab of its own" and must reach the fallback.
    // Number(null) is 0, so testing the coerced value would silently make every
    // untagged item tax-free.
    const own = item?.gstRate;
    const hasOwnRate = own !== null && own !== undefined && Number.isFinite(Number(own));
    const rate = hasOwnRate ? Number(own) : Number(fallbackRate) || 0;
    if (!(rate > 0)) continue;

    const lineValue = (Number(item?.price) || 0) * (Number(item?.quantity) || 1);
    tax += lineValue * taxableShare * (rate / 100);
  }

  return Math.round(tax);
}

/**
 * What a small basket is surcharged, and whether delivery is on the house.
 *
 * A rider rides the same distance for a ₹30 order as a ₹400 one, and until
 * these existed the system had no floor of any kind — the small one was simply
 * delivered at a loss. A surcharge rather than a hard minimum on purpose:
 * refusing the order loses the customer, charging for the trip prices it.
 *
 * Both are off unless an admin sets them, so nothing changes for an existing
 * installation until somebody decides it should.
 */
export function resolveCartAdjustments(feeSettings = {}, subtotal = 0) {
  const goods = Math.max(0, Number(subtotal) || 0);

  const threshold = Math.max(0, Number(feeSettings.smallCartThreshold) || 0);
  const fee = Math.max(0, Number(feeSettings.smallCartFee) || 0);
  // A zero basket is an empty cart, not a small one — it is priced at nothing
  // and the surcharge would be the entire bill.
  const smallCartFee = threshold > 0 && fee > 0 && goods > 0 && goods < threshold ? fee : 0;

  const freeAbove = Math.max(0, Number(feeSettings.freeDeliveryAbove) || 0);
  const deliveryIsFree = freeAbove > 0 && goods >= freeAbove;

  return {
    smallCartFee,
    smallCartThreshold: threshold,
    deliveryIsFree,
    freeDeliveryAbove: freeAbove,
    // What one more rupee of shopping would save, so the cart can say so.
    spendMoreForFreeDelivery: freeAbove > 0 && goods < freeAbove ? Math.ceil(freeAbove - goods) : 0,
  };
}

export function resolveUserDeliveryFee(feeSettings = {}, { subtotal = 0, distanceKm = null } = {}) {
  const ranges = Array.isArray(feeSettings.deliveryFeeRanges)
    ? feeSettings.deliveryFeeRanges
    : [];

  const { deliveryIsFree } = resolveCartAdjustments(feeSettings, subtotal);

  if (ranges.length > 0 && Number.isFinite(distanceKm)) {
    const matchedFee = matchFeeRange(ranges, distanceKm, (range) => Number(range.fee));
    if (Number.isFinite(matchedFee)) {
      return {
        deliveryFee: deliveryIsFree ? 0 : matchedFee,
        distanceKm: Number(distanceKm.toFixed(2)),
        source: deliveryIsFree ? 'free_over_threshold' : 'distance',
      };
    }
  }

  const fallbackFee = resolveBaseDeliveryFee(feeSettings);
  return {
    deliveryFee: deliveryIsFree ? 0 : fallbackFee,
    distanceKm: Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(2)) : null,
    source: deliveryIsFree
      ? 'free_over_threshold'
      : (Number.isFinite(distanceKm) ? 'default_unmatched_range' : 'default'),
  };
}

export function calculateRiderEarning(feeSettings = {}, distanceKm) {
  const ranges = Array.isArray(feeSettings.deliveryFeeRanges)
    ? feeSettings.deliveryFeeRanges
    : [];
  if (ranges.length === 0) return 0;

  // basePay and perKm are mutually exclusive (the admin UI enforces this too):
  // a flat basePay wins, otherwise pay per km of the actual trip.
  const payFor = (range, km) => {
    const basePay = Number(range?.deliveryBoyBasePay || 0);
    const perKm = Number(range?.deliveryBoyPerKm || 0);

    if (basePay > 0) return basePay;
    if (perKm > 0) return km * perKm;
    return 0;
  };

  // An unknown distance is not a zero-kilometre trip.
  //
  // Number(null) is 0, and 0 is finite and non-negative, so coercing before
  // testing made every order whose distance could not be resolved look like a
  // delivery to the shop's own door. calculateDistanceKm returns null (not 0)
  // when either endpoint lacks coordinates, and resolveUserDeliveryFee already
  // tells the two apart -- it tests Number.isFinite on the raw value, which is
  // false for null. This did not, so the customer correctly fell back to the
  // base fee while the rider was paid for 0 km.
  //
  // Falls back to the shortest band, mirroring the customer side's fallback to
  // the base fee. Deliberately not the widest band: one missing coordinate
  // should not trigger a full long-distance payout. A perKm-only band is
  // credited one kilometre so a real delivery never pays nothing.
  if (distanceKm === null || distanceKm === undefined || distanceKm === '') {
    const shortest = [...ranges].sort((a, b) => Number(a?.min ?? 0) - Number(b?.min ?? 0))[0];
    const guaranteed = payFor(shortest, 1);
    return Number.isFinite(guaranteed) ? Math.round(guaranteed) : 0;
  }

  const distance = Number(distanceKm);
  if (!Number.isFinite(distance) || distance < 0) return 0;

  const matched = matchFeeRange(ranges, distance, (range) => payFor(range, distance));
  // A matched band is authoritative — including an explicit 0.
  if (matched != null && Number.isFinite(matched)) return Math.round(matched);

  // No band covers this distance. The customer is still charged (resolveUserDeliveryFee
  // falls back to the base fee), so paying the rider 0 here would mean unpaid work on a
  // real delivery whenever the bands don't span the dispatch radius. Fall back to the
  // widest configured band instead of silently zeroing the payout.
  const widest = [...ranges].sort(
    (a, b) => Number(a?.max ?? 0) - Number(b?.max ?? 0),
  )[ranges.length - 1];
  const fallback = payFor(widest, distance);
  return Number.isFinite(fallback) ? Math.round(fallback) : 0;
}

/**
 * The address the trip should be priced against.
 *
 * Order creation passes a full `deliveryAddress`, but the checkout preview only
 * ever sends `deliveryAddressId`, and the cart summary sends neither — nothing
 * resolved either, so `distanceKm` came out null on every preview and the
 * distance bands were skipped entirely in favour of the flat fallback fee. The
 * customer saw one delivery charge at checkout and was billed another on
 * placing the order.
 *
 * An explicitly chosen address wins even when it has no coordinates: pricing a
 * different address than the one the customer picked would be worse than
 * falling back to the flat fee.
 */
async function resolveDeliveryAddress(userId, dto) {
  if (parseGeoPoint(dto.deliveryAddress)) return dto.deliveryAddress;
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
    return dto.deliveryAddress;
  }

  const user = await FoodUser.findById(userId).select('addresses').lean();
  const addresses = Array.isArray(user?.addresses) ? user.addresses : [];
  if (addresses.length === 0) return dto.deliveryAddress;

  const wantedId = String(dto.deliveryAddressId || '').trim();
  const chosen =
    (wantedId && addresses.find((entry) => String(entry?._id) === wantedId)) ||
    addresses.find((entry) => entry?.isDefault) ||
    addresses[0];

  return chosen || dto.deliveryAddress;
}

export async function calculateOrderPricing(userId, dto, options = {}) {
  const at = options.at instanceof Date ? options.at : new Date();
  const restaurant =
    options.restaurant || (await loadRestaurantForOrdering(dto.restaurantId));

  if (!options.skipAvailabilityCheck) {
    assertRestaurantOpenForOrdering(restaurant, at);
  }

  const deliveryAddress = normalizeDeliveryAddress(
    await resolveDeliveryAddress(userId, dto),
  );

  const resolvedItems = await resolveOrderCartItems(dto.restaurantId, dto.items);
  const items = resolvedItems.map((item) => ({
    ...item,
    price: Number(item.price) || 0,
    quantity: Number(item.quantity) || 1,
  }));
  const subtotal = round2(
    items.reduce(
      (sum, it) => sum + (Number(it.price) || 0) * (Number(it.quantity) || 1),
      0,
    ),
  );

  const feeSettings = await loadActiveFeeSettings();

  // A counter sale is handed over the counter: nobody drives it anywhere and
  // no app placed it, so neither a delivery fee nor the platform fee applies.
  // The "delivery address" is the shop's own, which would otherwise price a
  // zero-kilometre delivery at the base fee.
  const counterSale = options.counterSale === true;

  const packagingFee = 0;
  const platformFee = counterSale ? 0 : Number(feeSettings.platformFee || 0);

  let distanceKm = counterSale ? 0 : await getDeliveryDistanceKm(restaurant, deliveryAddress);
  const straightLineKm = counterSale ? 0 : calculateDistanceKm(restaurant, deliveryAddress);

  const deliveryFeeResult = counterSale
    ? { deliveryFee: 0, distanceKm: 0, source: "counter", breakdown: null }
    : resolveUserDeliveryFee(feeSettings, { subtotal, distanceKm });
  const deliveryFee = round2(deliveryFeeResult.deliveryFee);
  distanceKm = deliveryFeeResult.distanceKm ?? distanceKm;

  // What the store owes the road right now: how far the nearest usable rider
  // is, and how many doorsteps are already ahead of this one. Cached per store
  // for a few seconds, and falls back to nulls rather than failing a checkout.
  const dispatchPressure = await getStoreDispatchPressure(restaurant);

  let discount = 0;
  let appliedCoupon = null;
  // Why a code that was sent did not come off the bill, in the customer's
  // words. The code is echoed back either way (see couponCode below), so
  // without this a refused coupon is indistinguishable from an applied one
  // worth nothing — the cart reads "applied · you saved ₹0" and says nothing
  // about the ₹2 that would fix it. Slab coupons make that routine: a basket
  // crosses a threshold every time a quantity changes.
  let couponRejectedReason = "";
  // What reaching the next spend slab would be worth, when there is one.
  let couponNextSlab = null;
  const codeRaw = dto.couponCode
    ? String(dto.couponCode).trim().toUpperCase()
    : "";

  if (codeRaw) {
    const offer = await FoodOffer.findOne({ couponCode: codeRaw }).lean();
    if (!offer) {
      couponRejectedReason = "No such coupon";
    } else {
      // The same judgement the till's coupon list shows the cashier. Keeping
      // one implementation is the point: a list that offers a coupon this
      // engine then refuses is worse than no list at all.
      const customer = await loadCouponCustomerFacts(userId, [offer._id]);
      const verdict = evaluateCoupon(offer, {
        subtotal,
        restaurantId: dto.restaurantId,
        customer,
      });
      if (verdict.eligible) {
        discount = verdict.discount;
        appliedCoupon = { code: codeRaw, discount };
        couponNextSlab = verdict.nextSlab || null;
      } else {
        couponRejectedReason = verdict.reason || "";
      }
    }
  }

  // A discount the cashier typed in, on top of whatever a coupon gave. Clamped
  // so the two together can never exceed the goods: a bill cannot go negative
  // and the tax base below cannot either.
  const couponDiscount = discount;
  const manualPercent = Math.max(0, Math.min(100, Number(dto.manualDiscountPercent) || 0));
  const manualDiscount = round2(
    Math.max(
      0,
      Math.min(
        subtotal - couponDiscount,
        (Number(dto.manualDiscount) || 0) + (subtotal * manualPercent) / 100,
      ),
    ),
  );
  discount = round2(couponDiscount + manualDiscount);

  // GST is charged on the post-discount item value (discount is already clamped to <= subtotal).
  const tax = computeItemsTax(items, {
    subtotal,
    discount,
    fallbackRate: Number(feeSettings.gstRate || 0),
  });

  const deliveryFeeGst = computeDeliveryFeeGst(deliveryFee);

  const additionalCharges = round2(Math.max(0, Number(dto.additionalCharges) || 0));

  // Priced on the goods, so a coupon that shrinks the basket can push it under
  // the threshold — which is correct: what the rider carries is what was paid
  // for, and the trip costs the same either way.
  const cartAdjustments = resolveCartAdjustments(feeSettings, subtotal);
  const smallCartFee = round2(cartAdjustments.smallCartFee);

  const exactTotal = round2(
    Math.max(
      0,
      subtotal + packagingFee + deliveryFee + deliveryFeeGst + platformFee + smallCartFee + tax + additionalCharges - discount,
    ),
  );

  // Round-off is opt-in and signed. Rounding to the nearest rupee is what a
  // printed bill does; recording the difference is what keeps the ledger
  // honest about it.
  const roundOff = dto.roundOff === true ? round2(Math.round(exactTotal) - exactTotal) : 0;
  const total = round2(exactTotal + roundOff);

  const basePricing = {
    subtotal,
    tax,
    packagingFee,
    deliveryFee,
    deliveryFeeGst,
    platformFee,
    discount,
    total,
    currency: "INR",
    couponCode: appliedCoupon?.code || codeRaw || null,
    appliedCoupon,
    couponRejectedReason,
    couponNextSlab,
    manualDiscount,
    additionalCharges,
    smallCartFee,
    smallCartThreshold: cartAdjustments.smallCartThreshold,
    deliveryIsFree: cartAdjustments.deliveryIsFree,
    freeDeliveryAbove: cartAdjustments.freeDeliveryAbove,
    /** What one more rupee of shopping would save — the cart says this out loud. */
    spendMoreForFreeDelivery: cartAdjustments.spendMoreForFreeDelivery,
    roundOff,
    distanceKm: Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(2)) : null,
    roadDistanceKm: Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(2)) : null,
    straightLineDistanceKm: Number.isFinite(straightLineKm)
      ? Number(straightLineKm.toFixed(2))
      : null,
    deliveryFeeBreakdown: deliveryFeeResult.breakdown || null,
    // Shown before the customer commits, which is the whole point of a
    // quick-commerce promise: it is a reason to order, not a status to check
    // afterwards. Packing plus the ride, from the same numbers the live
    // countdown uses, so the quote and the tracking screen agree.
    // A quick order is dispatched unbatched (see canPartnerTakeOrder), so
    // nothing is queued in front of it and its quote says so. That mechanical
    // difference is what the surcharge buys — before it, the fee bought a
    // different label on an identical delivery.
    deliveryPromiseMinutes: estimateDeliveryPromiseMinutes(
      distanceKm,
      dto.deliveryMode === 'quick' ? { ...dispatchPressure, dropsAhead: 0 } : dispatchPressure,
    ),
    // Both modes quoted, so the cart can label the choice with real minutes
    // instead of the fixed bands it used to print. Free: the pressure behind
    // them was already measured for the line above.
    deliveryPromiseMinutesBasic: estimateDeliveryPromiseMinutes(distanceKm, dispatchPressure),
    deliveryPromiseMinutesQuick: estimateDeliveryPromiseMinutes(distanceKm, {
      ...dispatchPressure,
      dropsAhead: 0,
    }),
  };

  const pricing = applyDeliveryModePricing(
    basePricing,
    dto.deliveryMode,
    Number(feeSettings.quickDeliveryFee) || 0,
  );

  const priceChanges = (Array.isArray(dto.items) ? dto.items : [])
    .map((rawItem) => {
      const itemId = String(rawItem?.itemId || rawItem?.id || '').trim();
      const resolved = items.find((entry) => String(entry.itemId) === itemId);
      if (!resolved) return null;

      const previousPrice = Number(rawItem?.price);
      const nextPrice = Number(resolved.price);
      if (!Number.isFinite(previousPrice) || previousPrice === nextPrice) return null;

      return {
        itemId,
        name: resolved.name,
        previousPrice,
        price: nextPrice,
      };
    })
    .filter(Boolean);

  return {
    items,
    priceChanges,
    pricing: {
      ...pricing,
      deliveryFeeBreakdown: {
        source: deliveryFeeResult.source,
        distanceKm: Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(2)) : null,
        deliveryFee,
        message: Number.isFinite(distanceKm)
          ? `Distance: ${Number(distanceKm).toFixed(1)} km`
          : null,
      },
    },
  };
}
