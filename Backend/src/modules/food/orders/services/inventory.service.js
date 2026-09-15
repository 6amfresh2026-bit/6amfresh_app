import mongoose from 'mongoose';
import { FoodItem } from '../../admin/models/food.model.js';
import { FoodOrder } from '../models/order.model.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import { recordMovement } from './stockLedger.service.js';
import { allocateFefo, returnAllocations } from './stockBatch.service.js';

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

/**
 * Units of each product this order is actually holding.
 *
 * Same item can appear on several lines (different variants); the shelf sees
 * the sum.
 *
 * `fulfilledQuantity` wins over `quantity` when it has been set, because after
 * a short pick the order is only holding what the picker found — the rest went
 * back to the shelf at that moment. Reading the ordered figure here made
 * cancelling a short-picked order return those units a second time: four taken,
 * two returned at the shelf, four returned again on cancellation, and the
 * shelf quietly gained two units that never existed.
 *
 * It is null on every line that was never adjusted, including every order
 * placed before short-picking existed, so reservation at order time is
 * unchanged.
 */
/** What a line is still holding: what the picker found, else what was ordered. */
const deliverableQty = (line) => {
  const adjusted = line?.fulfilledQuantity;
  return adjusted === null || adjusted === undefined
    ? Math.max(0, Number(line?.quantity) || 0)
    : Math.max(0, Number(adjusted) || 0);
};

/**
 * The slice of a line's allocations covering `qty` units.
 *
 * A short pick has already given some units back, so the line may hold fewer
 * than it was allocated. Taken from the end — the last batch picked is the
 * first returned, which keeps the soonest-expiring units out on the shelf
 * where they need to sell.
 */
export function allocationsFor(line, qty) {
  let outstanding = Math.max(0, Number(qty) || 0);
  const out = [];
  const all = Array.isArray(line?.batchAllocations) ? [...line.batchAllocations].reverse() : [];
  for (const a of all) {
    if (outstanding <= 0) break;
    const take = Math.min(outstanding, Number(a?.quantity) || 0);
    if (take <= 0) continue;
    out.push({ batchId: a.batchId, quantity: take });
    outstanding -= take;
  }
  return out;
}

export function totalQuantityByItem(items = []) {
  const totals = new Map();
  for (const item of items) {
    const id = String(item?.itemId || '');
    if (!id || !mongoose.Types.ObjectId.isValid(id)) continue;

    const adjusted = item?.fulfilledQuantity;
    const wasAdjusted = adjusted !== null && adjusted !== undefined;
    // The floor-at-one guard only applies to the ordered figure, where zero
    // means a malformed line. An explicit zero from the picker means zero.
    const qty = wasAdjusted
      ? Math.max(0, Number(adjusted) || 0)
      : Math.max(1, Number(item?.quantity) || 1);

    if (qty === 0) continue;
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
  const now = new Date();

  for (const [itemId, qty] of totals) {
    const id = new mongoose.Types.ObjectId(itemId);

    // `$gte` never matches null, so untracked items fall through to the check
    // below rather than being silently decremented into negatives.
    //
    // findOneAndUpdate rather than updateOne: still one atomic operation, but
    // it hands back the post-decrement document, which is what the ledger row
    // needs for its before/after columns.
    const updated = await FoodItem.findOneAndUpdate(
      // Expired units never leave the shelf. Batch-tracked stock is guarded at
      // allocation; a product that keeps a single expiry has only this one
      // date, and without it the expiry was recorded, displayed, and then sold
      // past anyway. Part of the same atomic update as the count so the check
      // cannot be overtaken by an edit between read and write.
      { _id: id, stockQty: { $gte: qty }, $or: [{ expiryDate: null }, { expiryDate: { $gt: now } }] },
      { $inc: { stockQty: -qty } },
      // manageMultipleBatch rides along so the allocation below can be skipped
      // without a second lookup.
      { new: true, projection: { stockQty: 1, name: 1, itemCode: 1, restaurantId: 1, manageMultipleBatch: 1 } },
    ).lean();

    if (updated) {
      // Which units, now that we know how many. Deliberately after the
      // conditional decrement above, never instead of it: that single atomic
      // update is what stops two customers buying the last one, and batches
      // must not take that job over.
      //
      // Skipped entirely for a product nobody tracks by batch, which is almost
      // everything. Running it anyway cost a query per line and — worse — hit
      // the "no batch behind these units" branch on every ordinary sale,
      // logging an error about an inconsistency that did not exist and burying
      // the real ones under it.
      const allocations = updated.manageMultipleBatch
        ? await allocateFefo(itemId, qty, ctx)
        : [];
      taken.push({ itemId, qty, allocations });
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

    const doc = await FoodItem.findById(id).select('name stockQty expiryDate').lean();
    if (!doc) {
      await releaseReservations(taken, ctx);
      throw new ValidationError('One or more items are no longer available');
    }

    // Before the untracked check, not after: an item nobody counts never
    // reaches the decrement above, so this is the only place its expiry is
    // ever tested. Told apart from a stockout because "out of stock" would
    // send the customer back to wait for a restock that is not coming.
    if (doc.expiryDate && new Date(doc.expiryDate).getTime() <= now.getTime()) {
      await releaseReservations(taken, ctx);
      throw new ValidationError(`${doc.name} is past its expiry date and cannot be sold`);
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
      await returnAllocations(entry.allocations || []);
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
  //
  // An expired product is not brought back by units arriving either: this runs
  // on cancellation too, so restoring an order that happened to contain one
  // would put it back on the storefront until the next sweep — visible, and
  // refused at checkout.
  await FoodItem.updateOne(
    {
      _id: id,
      stockQty: { $gt: 0 },
      isAvailable: false,
      stockOffMode: { $in: [null, undefined] },
      $or: [{ expiryDate: null }, { expiryDate: { $gt: new Date() } }],
    },
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

  // Back to the intakes these units actually left. Returning them to whatever
  // expires soonest instead would quietly extend their shelf life, which is
  // the one mistake this whole feature exists to prevent.
  for (const line of claimed.items || []) {
    const owed = deliverableQty(line);
    if (owed > 0) await returnAllocations(allocationsFor(line, owed));
  }

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

/**
 * Takes expired products off the storefront.
 *
 * The reservation guard already refuses to sell them, but refusing at checkout
 * is the wrong place to find out: the customer has picked the thing, carried
 * it to payment and only then been told no. Hiding it keeps it out of the
 * cart in the first place.
 *
 * Only products carrying their own expiry. Batch-tracked stock is handled by
 * writeOffExpiredBatches, which removes the units themselves — here there are
 * no units to remove, just one date that has passed, so `isAvailable` is the
 * whole of the change and the count is left alone for whoever comes to count it.
 */
export async function hideExpiredProducts({ now = new Date() } = {}) {
  const result = await FoodItem.updateMany(
    {
      manageMultipleBatch: { $ne: true },
      expiryDate: { $ne: null, $lte: now },
      isAvailable: true,
    },
    // Marked as ours. `isAvailable: false` does not say who set it, and a
    // corrected expiry must revive only the products this sweep hid — never
    // one a seller switched off by hand or one that is out of stock.
    { $set: { isAvailable: false, hiddenByExpiry: true } },
  );

  const hidden = Number(result?.modifiedCount) || 0;
  if (hidden > 0) logger.info(`[stock] hid ${hidden} expired product(s) from the storefront`);
  return hidden;
}

/**
 * Puts a product back after its expiry date is corrected.
 *
 * A mistyped date takes the product off the storefront within the hour, and
 * without this the fix does nothing visible: the admin corrects the date, the
 * product stays dark, and nothing on the screen explains why. Reversing our own
 * hide is safe; reviving anything else is not, so this restores exactly the
 * products carrying the sweep's mark and leaves every other dark product alone.
 *
 * Call it after writing an expiry. It is a no-op for a product that was never
 * hidden, which is the ordinary case.
 */
export async function unhideCorrectedExpiry(itemId) {
  if (!itemId || !mongoose.Types.ObjectId.isValid(String(itemId))) return false;
  const id = new mongoose.Types.ObjectId(String(itemId));
  const now = new Date();
  const expiryIsFine = [{ expiryDate: null }, { expiryDate: { $gt: now } }];

  const restored = await FoodItem.updateOne(
    {
      _id: id,
      hiddenByExpiry: true,
      isAvailable: false,
      // A hand switch-off outranks a corrected date, exactly as it outranks a
      // restock, and a product with nothing on the shelf stays hidden for the
      // other reason it is hidden.
      stockOffMode: { $in: [null, undefined] },
      $and: [{ $or: expiryIsFine }, { $or: [{ stockQty: null }, { stockQty: { $gt: 0 } }] }],
    },
    { $set: { isAvailable: true, hiddenByExpiry: false } },
  );

  // The mark outlives the hide when somebody switches the product back on by
  // hand first. Left standing it would let a later correction revive a product
  // that by then is dark for a completely different reason.
  await FoodItem.updateOne(
    { _id: id, hiddenByExpiry: true, $or: expiryIsFine },
    { $set: { hiddenByExpiry: false } },
  );

  return (Number(restored?.modifiedCount) || 0) > 0;
}
