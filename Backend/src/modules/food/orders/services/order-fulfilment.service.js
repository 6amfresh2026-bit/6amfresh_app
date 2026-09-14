import mongoose from 'mongoose';

import { FoodOrder } from '../models/order.model.js';
import { FoodItem } from '../../admin/models/food.model.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import { returnStockUnits, reserveStockForItems } from './inventory.service.js';
import { pushStatusHistory } from './order.helpers.js';
import { computeItemsTax } from './order-pricing.service.js';

/**
 * Short picks and substitutions.
 *
 * Groceries go short. Until this existed the only expressible answers were
 * "deliver everything" or "cancel the whole order", and neither is what
 * actually happens at a shelf: the customer wanted ten things, nine are there,
 * and they would like those nine.
 *
 * Three things have to move together, which is why this is one function and
 * not three endpoints:
 *
 *  1. **The shelf.** Units reserved at order time that will not be delivered
 *     go back, or somebody else cannot buy them.
 *  2. **The bill.** The customer pays for what arrives. Fees are untouched —
 *     the rider still rode, the platform still ran — but the goods, their tax
 *     and any proportional part of a coupon are recomputed.
 *  3. **The money.** Cash-on-delivery gets a smaller amount for the rider to
 *     collect. Prepaid records what is owed — see the note at the bottom;
 *     executing a partial gateway refund is still to do.
 *
 * Only before the rider collects. Afterwards the goods are on a bike and the
 * question is a return, not a pick.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Statuses where the basket is still on the shelf and may still be changed. */
const ADJUSTABLE_STATUSES = ['created', 'confirmed', 'preparing', 'ready_for_pickup'];

const lineKey = (line) => `${String(line.itemId)}::${String(line.variantId || '')}`;

/** What a line is actually being delivered, falling back to what was ordered. */
export const deliveredQty = (line) =>
  line?.fulfilledQuantity === null || line?.fulfilledQuantity === undefined
    ? Number(line?.quantity) || 0
    : Number(line.fulfilledQuantity) || 0;

/** Goods value of a line as it will actually be delivered. */
const lineValue = (line) => round2((Number(line.price) || 0) * deliveredQty(line) - (Number(line.discount) || 0));

/**
 * Reprices an order against what is actually going in the bag.
 *
 * The coupon is scaled to the goods that survived rather than re-evaluated:
 * re-running the coupon rules here could withdraw a discount the customer was
 * already promised — telling someone who lost one item that they have also
 * lost their ₹50 off is a worse outcome than the shortfall itself. Scaling
 * keeps the proportion they were given.
 */
export function repriceForFulfilment(order) {
  const lines = order.items || [];
  const orderedGoods = round2(
    lines.reduce((sum, l) => sum + (Number(l.price) || 0) * (Number(l.quantity) || 0) - (Number(l.discount) || 0), 0),
  );
  const subtotal = round2(lines.reduce((sum, l) => sum + lineValue(l), 0));

  const pricing = order.pricing?.toObject?.() || { ...(order.pricing || {}) };
  const originalDiscount = Number(pricing.discount) || 0;

  // Never more than the goods that remain, or the bill goes negative.
  const discount =
    orderedGoods > 0 ? Math.min(subtotal, round2((originalDiscount * subtotal) / orderedGoods)) : 0;

  const taxableLines = lines
    .filter((l) => deliveredQty(l) > 0)
    .map((l) => ({ price: Number(l.price) || 0, quantity: deliveredQty(l), gstRate: l.gstRate ?? null }));
  // Same per-product slab maths the original bill used, so a short pick cannot
  // quietly change the tax treatment of the items that survived.
  const tax = round2(
    computeItemsTax(taxableLines, { subtotal, discount, fallbackRate: pricing.gstRate ?? 0 }),
  );

  const fees =
    (Number(pricing.deliveryFee) || 0) +
    (Number(pricing.deliveryFeeGst) || 0) +
    (Number(pricing.platformFee) || 0) +
    (Number(pricing.packagingFee) || 0) +
    (Number(pricing.additionalCharges) || 0);

  const total = Math.max(0, round2(subtotal - discount + tax + fees));

  return { ...pricing, subtotal, discount, tax, total, roundOff: 0 };
}

/**
 * Applies what the picker found.
 *
 * `lines` is a list of `{ itemId, variantId?, fulfilledQuantity }` and/or
 * `{ itemId, variantId?, substituteItemId }`. Anything not mentioned is
 * assumed found in full, so a picker only reports the exceptions.
 */
export async function adjustOrderFulfilment(orderId, { lines = [], byRole = 'RESTAURANT', note = '' } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ValidationError('Tell us which lines came up short');
  }

  const order = await FoodOrder.findById(orderId);
  if (!order) throw new NotFoundError('Order not found');

  if (!ADJUSTABLE_STATUSES.includes(String(order.orderStatus))) {
    throw new ValidationError(
      `This order is '${order.orderStatus}' — the goods have left the shelf, so it is a return rather than a short pick.`,
    );
  }
  if (order.deliveryState?.pickedUpAt) {
    throw new ValidationError('The rider already collected this order.');
  }

  const byKey = new Map(order.items.map((l) => [lineKey(l), l]));
  const returns = [];
  const takes = [];
  let substituted = false;

  for (const change of lines) {
    const key = `${String(change.itemId)}::${String(change.variantId || '')}`;
    const line = byKey.get(key);
    if (!line) throw new ValidationError(`No line on this order for item ${change.itemId}`);

    const ordered = Number(line.quantity) || 0;
    const current = deliveredQty(line);

    if (change.substituteItemId) {
      const replacement = await FoodItem.findById(change.substituteItemId)
        .select('_id name price gstRate restaurantId stockQty substituteItemIds isAvailable')
        .lean();
      if (!replacement) throw new NotFoundError('That replacement product does not exist');
      if (String(replacement.restaurantId) !== String(order.restaurantId)) {
        throw new ValidationError('A replacement has to come from the same store');
      }

      // Only what the original product nominates. A category is nowhere near a
      // good enough guess to spend the customer's money on.
      const allowed = (
        await FoodItem.findById(line.itemId).select('substituteItemIds').lean()
      )?.substituteItemIds || [];
      if (!allowed.some((id) => String(id) === String(replacement._id))) {
        throw new ValidationError(`${replacement.name} is not listed as a replacement for ${line.name}`);
      }

      const qty = Math.max(1, Number(change.quantity) || current || ordered);
      // Claims the units the same way an order does, and throws in the same
      // words if the shelf cannot supply them — "Soy Milk just went out of
      // stock" says more than any message this file could add.
      await reserveStockForItems(
        [{ itemId: String(replacement._id), quantity: qty }],
        { orderId: order._id, orderLabel: order.order_id || '' },
      );
      takes.push({ itemId: String(replacement._id), qty });

      // The original line goes to zero and its units go back; the replacement
      // is a new line that remembers what it stood in for, so the invoice can
      // say so rather than silently showing a product nobody ordered.
      if (current > 0) returns.push({ itemId: String(line.itemId), qty: current });
      line.fulfilledQuantity = 0;

      order.items.push({
        itemId: String(replacement._id),
        name: replacement.name,
        price: Number(replacement.price) || 0,
        variantPrice: Number(replacement.price) || 0,
        quantity: qty,
        fulfilledQuantity: qty,
        gstRate: replacement.gstRate ?? null,
        isVeg: line.isVeg !== false,
        substitutedForItemId: String(line.itemId),
        substitutedForName: line.name,
      });
      substituted = true;
      continue;
    }

    const found = Number(change.fulfilledQuantity);
    if (!Number.isFinite(found) || found < 0) throw new ValidationError('Fulfilled quantity must be zero or more');
    if (found > ordered) {
      throw new ValidationError(`Cannot deliver ${found} of ${line.name}; only ${ordered} were ordered`);
    }
    if (found === current) continue;

    if (found < current) returns.push({ itemId: String(line.itemId), qty: current - found });
    line.fulfilledQuantity = found;
  }

  const kept = order.items.filter((l) => deliveredQty(l) > 0);
  if (kept.length === 0) {
    // Nothing left to deliver is a cancellation, and cancellation has its own
    // path with its own refund and its own notification. Doing it quietly here
    // would leave an order that is delivered, empty and paid for.
    throw new ValidationError('Nothing would be left to deliver — cancel the order instead.');
  }

  const before = Number(order.pricing?.total) || 0;
  const repriced = repriceForFulfilment(order);
  const shortfall = Math.max(0, round2(before - repriced.total));

  order.pricing = repriced;
  order.fulfillment = {
    status: substituted ? 'substituted' : 'partial',
    adjustedAt: new Date(),
    adjustedByRole: byRole,
    shortfallAmount: shortfall,
    note: String(note || ''),
  };

  // Cash on delivery: the rider simply collects less, and amountDue below is
  // what they will actually take.
  //
  // Prepaid is only RECORDED here, not refunded. fulfillment.shortfallAmount
  // is the figure owed and it is persisted on the order, but no gateway call
  // is made — a partial refund cannot reuse the cancellation path, which marks
  // payment.status 'refunded' and would claim the whole order had been given
  // back. Wiring a genuine partial refund is the remaining piece; until then
  // the amount is visible rather than silently dropped.
  const paymentStatus = String(order.payment?.status || '').toLowerCase();
  const alreadyPaid = ['paid', 'authorized'].includes(paymentStatus);
  if (!alreadyPaid) {
    order.payment.amountDue = Math.max(0, round2(repriced.total));
  }

  pushStatusHistory(order, {
    byRole,
    from: order.orderStatus,
    to: order.orderStatus,
    note: `Short pick: bill reduced by ₹${shortfall}${note ? ` — ${note}` : ''}`,
  });

  await order.save();

  // After the save, so a failed write cannot hand stock back for an
  // adjustment that never happened.
  for (const entry of returns) {
    try {
      await returnStockUnits(entry.itemId, entry.qty, {
        orderId: order._id,
        orderLabel: order.order_id || '',
        reason: 'Short picked at the shelf',
      });
    } catch (err) {
      logger.error(`[CRITICAL] short-pick restock failed for ${entry.itemId} (+${entry.qty}): ${err?.message || err}`);
    }
  }

  return {
    orderId: String(order._id),
    order_id: order.order_id,
    fulfillment: order.fulfillment,
    pricing: repriced,
    refundDue: alreadyPaid ? shortfall : 0,
    amountDue: alreadyPaid ? 0 : Math.max(0, round2(repriced.total)),
    substitutions: takes.length,
  };
}

/** What the picker may offer instead, and whether it is actually on the shelf. */
export async function listSubstitutesForItem(itemId) {
  if (!mongoose.Types.ObjectId.isValid(String(itemId))) throw new NotFoundError('Product not found');
  const item = await FoodItem.findById(itemId).select('name substituteItemIds').lean();
  if (!item) throw new NotFoundError('Product not found');
  if (!item.substituteItemIds?.length) return { itemId: String(itemId), name: item.name, substitutes: [] };

  const rows = await FoodItem.find({ _id: { $in: item.substituteItemIds }, isDeleted: { $ne: true } })
    .select('_id name price mrp image stockQty isAvailable packSize')
    .lean();

  return {
    itemId: String(itemId),
    name: item.name,
    substitutes: rows.map((r) => ({
      id: String(r._id),
      name: r.name,
      price: r.price,
      mrp: r.mrp ?? null,
      image: r.image || '',
      packSize: r.packSize || '',
      // An untracked product is always offerable; a tracked one has to have units.
      inStock: r.stockQty === null || r.stockQty === undefined ? r.isAvailable !== false : r.stockQty > 0,
      stockQty: r.stockQty ?? null,
    })),
  };
}
