import mongoose from 'mongoose';
import { FoodItem } from '../../admin/models/food.model.js';
import { FoodOrder } from '../models/order.model.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import { recordMovement } from './stockLedger.service.js';

/** Ledger reference for an order, when the caller can name one. */
const orderRef = (ctx) =>
  ctx?.orderId ? { kind: 'order', id: ctx.orderId, label: ctx.orderLabel || '' } : { kind: 'system', id: null, label: '' };

/**
 * Stock reservation for quick commerce.
 *
 * Food delivery never tracked quantities: a dish was a boolean, and a kitchen
 * that runs out just toggles it off. Groceries are countable, so an order has
 * to claim units at creation or two customers can both buy the last one and the
 * second finds out only after paying.
 *
 * Items with `stockQty === null` are untracked and pass straight through, which
 * is every document that existed before this file.
 */

/** Same item can appear on several lines (different variants); the shelf sees the sum. */
export function totalQuantityByItem(items = []) {
  const totals = new Map();
  for (const item of items) {
    const id = String(item?.itemId || '');
    if (!id || !mongoose.Types.ObjectId.isValid(id)) continue;
    const qty = Math.max(1, Number(item?.quantity) || 1);
    totals.set(id, (totals.get(id) || 0) + qty);
  }
  return totals;
}

/**
 * Decrements stock for every tracked item on the order.
 *
 * Each decrement is a conditional update, so the check and the write are one
 * atomic operation and concurrent orders cannot both pass a "do we have enough"
 * read. If any item comes up short, the ones already taken are put back before
 * throwing — a rejected order must leave the shelf exactly as it found it.
 */
export async function reserveStockForItems(items = [], ctx = {}) {
  const totals = totalQuantityByItem(items);
  if (totals.size === 0) return [];

  const taken = [];

  for (const [itemId, qty] of totals) {
    const id = new mongoose.Types.ObjectId(itemId);

    // `$gte` never matches null, so untracked items fall through to the check
    // below rather than being silently decremented into negatives.
    //
    // findOneAndUpdate rather than updateOne: still one atomic operation, but
    // it hands back the post-decrement document, which is what the ledger row
    // needs for its before/after columns.
    const updated = await FoodItem.findOneAndUpdate(
      { _id: id, stockQty: { $gte: qty } },
      { $inc: { stockQty: -qty } },
      { new: true, projection: { stockQty: 1, name: 1, itemCode: 1, restaurantId: 1 } },
    ).lean();

    if (updated) {
      taken.push({ itemId, qty });
      // Hide it once empty so the existing listing/search filters, which all key
      // off isAvailable, keep working without knowing inventory exists.
      await FoodItem.updateOne(
        { _id: id, stockQty: 0 },
        { $set: { isAvailable: false } },
      );
      void recordMovement({
        itemId: id,
        item: updated,
        type: 'sale',
        qtyChange: -qty,
        qtyBefore: updated.stockQty + qty,
        qtyAfter: updated.stockQty,
        reference: orderRef(ctx),
      });
      continue;
    }

    const doc = await FoodItem.findById(id).select('name stockQty').lean();
    if (!doc) {
      await releaseReservations(taken, ctx);
      throw new ValidationError('One or more items are no longer available');
    }
    if (doc.stockQty === null || doc.stockQty === undefined) continue; // untracked

    await releaseReservations(taken, ctx);
    const left = Number(doc.stockQty) || 0;
    throw new ValidationError(
      left > 0
        ? `Only ${left} left of ${doc.name}. Please reduce the quantity.`
        : `${doc.name} just went out of stock`,
    );
  }

  return taken;
}

/** Puts back a partial reservation after a failed line. Never throws. */
export async function releaseReservations(taken = [], ctx = {}) {
  for (const entry of taken) {
    try {
      await incrementStock(entry.itemId, entry.qty, { ...ctx, reason: 'Order rejected before it was placed' });
    } catch (err) {
      logger.error(
        `[CRITICAL] stock rollback failed for item ${entry.itemId} (+${entry.qty}): ${err?.message || err}`,
      );
    }
  }
}

/**
 * Puts units back on the shelf that an order claimed but did not consume.
 *
 * Used when a line is short-picked or swapped out: those units were reserved
 * at order time and are now available to somebody else. Distinct from
 * restoreOrderStock(), which gives back a whole order exactly once — a short
 * pick returns part of one and the order lives on.
 */
export async function returnStockUnits(itemId, qty, ctx = {}) {
  const units = Math.max(0, Number(qty) || 0);
  if (!itemId || units === 0) return false;
  await incrementStock(itemId, units, { ...ctx, reason: ctx.reason || 'Short picked at the shelf' });
  return true;
}

async function incrementStock(itemId, qty, ctx = {}) {
  const id = new mongoose.Types.ObjectId(String(itemId));
  const updated = await FoodItem.findOneAndUpdate(
    { _id: id, stockQty: { $ne: null } },
    { $inc: { stockQty: qty } },
    { new: true, projection: { stockQty: 1, name: 1, itemCode: 1, restaurantId: 1 } },
  ).lean();
  // Bring it back only if it went dark by running out. A seller who switched the
  // item off by hand set stockOffMode, and that decision outranks a restock.
  await FoodItem.updateOne(
    { _id: id, stockQty: { $gt: 0 }, isAvailable: false, stockOffMode: { $in: [null, undefined] } },
    { $set: { isAvailable: true } },
  );
  if (updated) {
    void recordMovement({
      itemId: id,
      item: updated,
      type: 'sale_return',
      qtyChange: qty,
      qtyBefore: updated.stockQty - qty,
      qtyAfter: updated.stockQty,
      reason: ctx.reason || 'Order cancelled',
      reference: orderRef(ctx),
    });
  }
}

/**
 * Returns an order's reserved stock to the shelf.
 *
 * Safe to call from anywhere an order dies — cancellation by user, seller,
 * admin or the acceptance timeout, and the two delete paths. The claim on
 * `stockRestoredAt` is what makes that safe: several of those paths can fire
 * for the same order (the timeout sweep runs from both a queue job and four
 * read paths), and a double restock would quietly invent inventory.
 */
export async function restoreOrderStock(orderLike) {
  const orderId = orderLike?._id;
  if (!orderId) return false;
  if (!orderLike?.stockReservedAt) return false; // pre-inventory or never reserved

  const claimed = await FoodOrder.findOneAndUpdate(
    { _id: orderId, stockReservedAt: { $ne: null }, stockRestoredAt: null },
    { $set: { stockRestoredAt: new Date() } },
    { new: true, projection: { items: 1 } },
  ).lean();

  if (!claimed) return false; // already restored, or nothing to restore

  const orderLabel = orderLike?.order_id || orderLike?.orderId || '';
  for (const [itemId, qty] of totalQuantityByItem(claimed.items)) {
    try {
      await incrementStock(itemId, qty, { orderId, orderLabel, reason: 'Order cancelled / expired' });
    } catch (err) {
      logger.error(
        `[CRITICAL] restock failed for order ${orderId} item ${itemId} (+${qty}): ${err?.message || err}`,
      );
    }
  }

  return true;
}
