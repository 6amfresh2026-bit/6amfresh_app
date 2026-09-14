import mongoose from 'mongoose';

import { FoodOrder } from '../models/order.model.js';
import { FoodItem } from '../../admin/models/food.model.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import { returnStockUnits, reserveStockForItems, allocationsFor } from './inventory.service.js';
import { returnAllocations } from './stockBatch.service.js';

/** What a line keeps after `kept` units of its allocations are retained. */
const shrinkAllocations = (allocations, kept) => {
  let left = Math.max(0, Number(kept) || 0);
  const out = [];
  for (const a of Array.isArray(allocations) ? allocations : []) {
    if (left <= 0) break;
    const take = Math.min(left, Number(a?.quantity) || 0);
    if (take <= 0) continue;
    out.push({ ...(a.toObject?.() || a), quantity: take });
    left -= take;
  }
  return out;
};
import { pushStatusHistory } from './order.helpers.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { initiateRazorpayRefund } from '../helpers/razorpay.helper.js';
import { refundWalletBalance } from '../../user/services/userWallet.service.js';
import { computeItemsTax } from './order-pricing.service.js';
import { getRestaurantCommissionSnapshot, repriceTransactionForOrder } from './foodTransaction.service.js';

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

  // Carried across unchanged, not recomputed. A short pick can push the basket
  // under the small-cart threshold, and charging the customer a surcharge
  // because the shop ran out would be billing them for our mistake. Equally it
  // is not dropped: the trip was already priced on the basket they ordered.
  const fees =
    (Number(pricing.deliveryFee) || 0) +
    (Number(pricing.deliveryFeeGst) || 0) +
    (Number(pricing.platformFee) || 0) +
    (Number(pricing.packagingFee) || 0) +
    (Number(pricing.smallCartFee) || 0) +
    (Number(pricing.additionalCharges) || 0);

  const total = Math.max(0, round2(subtotal - discount + tax + fees));

  return { ...pricing, subtotal, discount, tax, total, roundOff: 0 };
}

/**
 * Gives back the difference on an order that was already paid for.
 *
 * Deliberately NOT the cancellation refund path: that one sets
 * payment.status to 'refunded', which would claim the whole order had been
 * given back when only part of it was. The payment stays 'paid' — because it
 * is — and the refund sub-document carries what went back.
 *
 * Never throws. A gateway that is down must not undo a short pick the picker
 * has already acted on; the shortfall is recorded either way and a failed
 * refund is visible as 'failed' rather than silently dropped.
 */
async function refundShortfall(order, amount) {
  const method = String(order.payment?.method || '').toLowerCase();

  try {
    if (method === 'wallet') {
      await refundWalletBalance(
        order.userId,
        amount,
        `Short pick refund for order #${order.order_id || order._id}`,
        { orderId: order._id },
      );
      return { status: 'processed', method: 'wallet', refundId: '' };
    }

    if (method === 'razorpay' || method === 'razorpay_qr') {
      const paymentId = order.payment?.razorpay?.paymentId;
      if (!paymentId) return { status: 'pending', method, refundId: '' };
      const result = await initiateRazorpayRefund(paymentId, amount);
      return result?.success
        ? { status: 'processed', method, refundId: result.refundId || '' }
        : { status: 'failed', method, refundId: '' };
    }

    // Anything else — a counter tender, say — has no automated way back.
    return { status: 'pending', method, refundId: '' };
  } catch (err) {
    logger.error(`Short-pick refund failed for order ${order._id}: ${err?.message || err}`);
    return { status: 'failed', method, refundId: '' };
  }
}

/**
 * Puts back replacement stock claimed for a substitution that then failed.
 *
 * The replacement is taken from the shelf before the order is saved, so every
 * throw between those two points would otherwise strand those units: claimed
 * against an order that does not reference them, and invisible to every
 * restock path there is.
 */
async function releaseTakenReplacements(takes = []) {
  for (const entry of takes) {
    try {
      await returnStockUnits(entry.itemId, entry.qty, { reason: 'Substitution abandoned' });
    } catch (err) {
      logger.error(
        `[CRITICAL] could not put back replacement stock ${entry.itemId} (+${entry.qty}): ${err?.message || err}`,
      );
    }
  }
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

  try {
  for (const change of lines) {
    const key = `${String(change.itemId)}::${String(change.variantId || '')}`;
    const line = byKey.get(key);
    if (!line) throw new ValidationError(`No line on this order for item ${change.itemId}`);

    const ordered = Number(line.quantity) || 0;
    const current = deliveredQty(line);

    if (change.substituteItemId) {
      // Silence is not consent. Swapping without it spends the customer's
      // money on something they did not choose — and the lactose-free shopper
      // handed ordinary milk has been sold the one thing they were avoiding.
      if (String(order.substitutionPreference || 'refund') !== 'allow') {
        throw new ValidationError(
          `${line.name} cannot be replaced — this customer asked for a refund instead of substitutions.`,
        );
      }

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
      if (current > 0) {
        returns.push({
          itemId: String(line.itemId),
          qty: current,
          allocations: allocationsFor(line, current),
        });
      }
      line.batchAllocations = [];
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

    if (found < current) {
      const giveBack = current - found;
      // Taken from the end of the line's allocations: the last batch picked is
      // the first put back, leaving the soonest-expiring units out on the
      // shelf where they still have to sell.
      returns.push({
        itemId: String(line.itemId),
        qty: giveBack,
        allocations: allocationsFor(line, giveBack),
      });
      line.batchAllocations = shrinkAllocations(line.batchAllocations, found);
    }
    line.fulfilledQuantity = found;
  }

  const kept = order.items.filter((l) => deliveredQty(l) > 0);
  if (kept.length === 0) {
    // Nothing left to deliver is a cancellation, and cancellation has its own
    // path with its own refund and its own notification. Doing it quietly here
    // would leave an order that is delivered, empty and paid for.
    throw new ValidationError('Nothing would be left to deliver — cancel the order instead.');
  }
  } catch (err) {
    // Any refusal from here back to the first reserve leaves replacement units
    // claimed against an order that will not carry them. Every throw in the
    // block above has to give them back — a later line naming a product that
    // is not on the order, an emptied basket, anything.
    await releaseTakenReplacements(takes);
    throw err;
  }

  // Measured against the bill as it was BEFORE anything went short, not
  // against the last adjustment. An order short-picked and then substituted
  // would otherwise report only the second delta, and a refund paid against
  // that figure would underpay the customer by the first one.
  const originalTotal =
    Number(order.fulfillment?.originalTotal) || Number(order.pricing?.total) || 0;
  const repriced = repriceForFulfilment(order);
  const shortfall = Math.max(0, round2(originalTotal - repriced.total));

  // The seller's commission is charged on the goods. Left alone it would keep
  // describing the basket that was ordered, so a store short by one item would
  // still pay commission on the item it never sold. Recomputed rather than
  // scaled, because a commission rule can be a flat fee as well as a
  // percentage and only the rule itself knows which.
  try {
    const snapshot = await getRestaurantCommissionSnapshot({
      pricing: repriced,
      restaurantId: order.restaurantId,
    });
    repriced.restaurantCommission = Number(snapshot?.commissionAmount) || 0;
  } catch (err) {
    logger.warn(`Commission recalculation after short pick failed: ${err?.message || err}`);
  }

  order.pricing = repriced;
  order.fulfillment = {
    status: substituted ? 'substituted' : 'partial',
    adjustedAt: new Date(),
    adjustedByRole: byRole,
    originalTotal,
    shortfallAmount: shortfall,
    note: String(note || ''),
  };

  // Cash on delivery: the rider simply collects less, and amountDue is what
  // they will actually take. Prepaid is genuinely refunded below.
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

  // Give the money back before saving the refund record, so a gateway that
  // refuses is never written down as processed.
  // `shortfall` is cumulative against the original bill, so a second short
  // pick on the same order must only move the DIFFERENCE. Refunding the
  // cumulative figure again pays the first shortfall twice — on a ₹400 order
  // short-picked to ₹300 and then to ₹200, the customer is owed ₹200 and was
  // being given ₹300.
  //
  // A refund that previously FAILED counts as nothing given back, so the whole
  // outstanding amount is attempted again rather than written off.
  const previous = order.payment?.refund || {};
  const alreadyRefunded = String(previous.status) === 'processed' ? Number(previous.amount) || 0 : 0;
  const owedNow = round2(shortfall - alreadyRefunded);

  let refund = null;
  if (alreadyPaid && owedNow > 0) {
    refund = await refundShortfall(order, owedNow);
    const settled = refund.status === 'processed';
    order.payment.refund = {
      status: refund.status,
      // Cumulative total returned, not this instalment: the order has to say
      // how much of the bill came back altogether.
      amount: settled ? round2(alreadyRefunded + owedNow) : round2(alreadyRefunded),
      refundId: refund.refundId || previous.refundId || '',
      processedAt: settled ? new Date() : previous.processedAt,
    };
  }

  try {
    await order.save();
  } catch (err) {
    // Replacement units were claimed before this point and this order will now
    // carry none of them, so nothing downstream could ever give them back.
    await releaseTakenReplacements(takes);
    throw err;
  }

  // The settlement side reads `amounts` on the transaction in preference to
  // `pricing` on the order, so repricing the order alone would leave the
  // seller's payout describing a basket that was never delivered.
  try {
    await repriceTransactionForOrder(order);
  } catch (err) {
    logger.error(`[CRITICAL] transaction reprice failed for order ${order._id}: ${err?.message || err}`);
  }

  // After the save, so a failed write cannot hand stock back for an
  // adjustment that never happened.
  for (const entry of returns) {
    try {
      // The batches first, then the count, so the two move together.
      if (entry.allocations?.length) await returnAllocations(entry.allocations);
      await returnStockUnits(entry.itemId, entry.qty, {
        orderId: order._id,
        orderLabel: order.order_id || '',
        reason: 'Short picked at the shelf',
      });
    } catch (err) {
      logger.error(`[CRITICAL] short-pick restock failed for ${entry.itemId} (+${entry.qty}): ${err?.message || err}`);
    }
  }

  // The customer's bill just changed under them. Telling them is not optional:
  // a basket that silently arrives smaller and cheaper reads as a mistake, or
  // as theft, depending on which way they notice first.
  try {
    const io = getIO();
    if (io && order.userId) {
      io.to(rooms.user(order.userId)).emit('order_fulfilment_changed', {
        orderMongoId: String(order._id),
        orderId: order.order_id || String(order._id),
        status: order.fulfillment.status,
        shortfallAmount: shortfall,
        total: repriced.total,
        refundDue: alreadyPaid ? shortfall : 0,
        amountDue: alreadyPaid ? 0 : Math.max(0, round2(repriced.total)),
        items: order.items
          .filter((l) => Number(l.quantity) !== deliveredQty(l) || l.substitutedForItemId)
          .map((l) => ({
            name: l.name,
            ordered: Number(l.quantity) || 0,
            arriving: deliveredQty(l),
            substitutedFor: l.substitutedForName || '',
          })),
        note: order.fulfillment.note,
      });
    }
  } catch (err) {
    logger.warn(`Could not tell the customer about the short pick: ${err?.message || err}`);
  }

  return {
    orderId: String(order._id),
    order_id: order.order_id,
    fulfillment: order.fulfillment,
    pricing: repriced,
    refund: refund ? { status: refund.status, amount: owedNow, method: refund.method } : null,
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
