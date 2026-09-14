import mongoose from 'mongoose';

import { FoodStockBatch } from '../models/stockBatch.model.js';
import { FoodItem } from '../../admin/models/food.model.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import { recordMovement } from './stockLedger.service.js';

/**
 * Batches, and picking the one that goes off first.
 *
 * The product's `stockQty` still decides whether a sale may happen — one
 * conditional decrement, which is what stops two customers buying the last
 * unit. This file never competes with that. It answers a different question:
 * of the units we hold, *which* ones are going out of the door.
 *
 * FEFO, not FIFO. What arrived first is not always what goes off first: a
 * short-dated delivery can arrive after a long-dated one, and picking by
 * arrival date would leave the short-dated stock to spoil on the shelf.
 */

const oid = (v) => new mongoose.Types.ObjectId(String(v));

/** Whether this product is tracked batch by batch at all. */
export async function usesBatches(itemId) {
    const item = await FoodItem.findById(itemId).select('manageMultipleBatch').lean();
    return Boolean(item?.manageMultipleBatch);
}

/**
 * Records an intake and puts its units on the shelf.
 *
 * The one way stock should enter a batch-tracked product. `stockQty` moves
 * with it so the two never disagree — a batch nobody counted is stock nobody
 * can sell, and a count with no batch behind it is stock nobody can trace.
 */
export async function receiveBatch({
    itemId,
    batchNo = '',
    expiryDate = null,
    quantity,
    purchasePrice = null,
    receivedAt = new Date(),
    reason = 'Stock received',
} = {}) {
    const qty = Math.floor(Number(quantity) || 0);
    if (!mongoose.Types.ObjectId.isValid(String(itemId))) throw new NotFoundError('Product not found');
    if (qty <= 0) throw new ValidationError('Received quantity must be more than zero');

    const item = await FoodItem.findById(itemId).select('name itemCode restaurantId stockQty manageMultipleBatch').lean();
    if (!item) throw new NotFoundError('Product not found');

    const expiry = expiryDate ? new Date(expiryDate) : null;
    if (expiry && Number.isNaN(expiry.getTime())) throw new ValidationError('Invalid expiry date');
    if (expiry && expiry.getTime() <= Date.now()) {
        // Receiving something already expired is a data-entry slip, not an
        // intake. Accepting it would put unsellable units into the count.
        throw new ValidationError('That batch has already expired');
    }

    const batch = await FoodStockBatch.create({
        itemId: oid(itemId),
        restaurantId: item.restaurantId,
        batchNo: String(batchNo || '').trim(),
        expiryDate: expiry,
        receivedAt,
        receivedQty: qty,
        remainingQty: qty,
        purchasePrice: Number.isFinite(Number(purchasePrice)) ? Number(purchasePrice) : null,
    });

    // Untracked products carry stockQty null and must stay that way — putting
    // a number on one would silently switch it into tracked stock.
    const updated = await FoodItem.findOneAndUpdate(
        { _id: oid(itemId), stockQty: { $ne: null } },
        { $inc: { stockQty: qty } },
        { new: true, projection: { stockQty: 1, name: 1, itemCode: 1, restaurantId: 1 } },
    ).lean();

    if (updated) {
        await FoodItem.updateOne(
            { _id: oid(itemId), stockQty: { $gt: 0 }, isAvailable: false, stockOffMode: { $in: [null, undefined] } },
            { $set: { isAvailable: true } },
        );
        void recordMovement({
            itemId: oid(itemId),
            item: updated,
            type: 'purchase',
            qtyChange: qty,
            qtyBefore: updated.stockQty - qty,
            qtyAfter: updated.stockQty,
            reason,
            note: batch.batchNo ? `Batch ${batch.batchNo}` : '',
        });
    }

    return { batchId: String(batch._id), stockQty: updated?.stockQty ?? null };
}

/**
 * Chooses which units leave the shelf, soonest expiry first.
 *
 * Called *after* the product's stockQty has already been decremented, so the
 * sale is settled by then and this cannot refuse it. If the batches somehow
 * hold less than the sale took — a hand-edited count, an intake nobody
 * recorded — it allocates what it can and says so loudly rather than throwing,
 * because failing here would leave a paid order with no stock behind it.
 */
export async function allocateFefo(itemId, quantity, ctx = {}) {
    const needed = Math.floor(Number(quantity) || 0);
    if (needed <= 0) return [];

    // Sorted on a computed key, not on expiryDate directly: Mongo sorts null
    // BEFORE dates ascending, so a never-expiring batch would be picked ahead
    // of short-dated stock and the dated stock would be left to spoil — the
    // exact failure FEFO exists to prevent. Undated batches are pushed to the
    // far future so they are always picked last.
    const batches = await FoodStockBatch.aggregate([
        {
            $match: {
                itemId: oid(itemId),
                status: 'active',
                remainingQty: { $gt: 0 },
            },
        },
        { $addFields: { expirySortKey: { $ifNull: ['$expiryDate', new Date('9999-12-31T00:00:00.000Z')] } } },
        { $sort: { expirySortKey: 1, receivedAt: 1 } },
    ]);

    const allocations = [];
    let outstanding = needed;

    for (const batch of batches) {
        if (outstanding <= 0) break;
        const take = Math.min(outstanding, Number(batch.remainingQty) || 0);
        if (take <= 0) continue;

        // Conditional on the quantity still being there, so two concurrent
        // picks cannot both take the same last unit of a batch.
        const claimed = await FoodStockBatch.findOneAndUpdate(
            { _id: batch._id, remainingQty: { $gte: take } },
            { $inc: { remainingQty: -take } },
            { new: true },
        ).lean();
        if (!claimed) continue;

        allocations.push({
            batchId: String(batch._id),
            batchNo: batch.batchNo || '',
            expiryDate: batch.expiryDate || null,
            quantity: take,
        });
        outstanding -= take;
    }

    if (outstanding > 0) {
        logger.error(
            `[stock-batch] ${outstanding} of ${needed} units for item ${itemId} had no batch behind them ` +
            `(order ${ctx.orderLabel || ctx.orderId || 'unknown'}). The shelf count and the batches disagree.`,
        );
    }

    return allocations;
}

/** Puts allocated units back, to the batches they actually came from. */
export async function returnAllocations(allocations = []) {
    for (const entry of allocations) {
        const qty = Math.max(0, Number(entry?.quantity) || 0);
        if (!qty || !entry?.batchId) continue;
        try {
            await FoodStockBatch.updateOne(
                { _id: oid(entry.batchId), status: 'active' },
                { $inc: { remainingQty: qty } },
            );
        } catch (err) {
            logger.error(`[stock-batch] could not return ${qty} to batch ${entry.batchId}: ${err?.message || err}`);
        }
    }
}

/**
 * Takes expired stock off the shelf.
 *
 * Expired units are not sellable, so leaving them in `stockQty` would let the
 * shop sell them — the one failure in this whole feature that a refund does
 * not undo. Writes the batch off and removes exactly its remaining units from
 * the count, recorded as an adjustment so the ledger explains the drop.
 */
export async function writeOffExpiredBatches({ now = new Date() } = {}) {
    const expired = await FoodStockBatch.find({
        status: 'active',
        remainingQty: { $gt: 0 },
        expiryDate: { $ne: null, $lte: now },
    }).lean();

    let written = 0;

    for (const batch of expired) {
        // Claim it first: the sweep runs from more than one place and writing
        // a batch off twice would take its units out of the count twice.
        const claimed = await FoodStockBatch.findOneAndUpdate(
            { _id: batch._id, status: 'active' },
            { $set: { status: 'written_off', writtenOffAt: now, writtenOffReason: 'Expired' } },
            { new: false },
        ).lean();
        if (!claimed) continue;

        const units = Math.max(0, Number(claimed.remainingQty) || 0);
        await FoodStockBatch.updateOne({ _id: batch._id }, { $set: { remainingQty: 0 } });
        if (units === 0) continue;

        const updated = await FoodItem.findOneAndUpdate(
            { _id: claimed.itemId, stockQty: { $gte: units } },
            { $inc: { stockQty: -units } },
            { new: true, projection: { stockQty: 1, name: 1, itemCode: 1, restaurantId: 1 } },
        ).lean();

        if (updated) {
            await FoodItem.updateOne({ _id: claimed.itemId, stockQty: 0 }, { $set: { isAvailable: false } });
            void recordMovement({
                itemId: claimed.itemId,
                item: updated,
                type: 'adjustment',
                qtyChange: -units,
                qtyBefore: updated.stockQty + units,
                qtyAfter: updated.stockQty,
                reason: 'Expired',
                note: claimed.batchNo ? `Batch ${claimed.batchNo}` : '',
            });
            written += 1;
        } else {
            logger.error(
                `[stock-batch] expired batch ${batch._id} held ${units} units the product count could not cover.`,
            );
        }
    }

    if (written > 0) logger.warn(`[stock-batch] wrote off ${written} expired batch(es).`);
    return written;
}

/**
 * What is on the shelf and when it goes off.
 *
 * `expiringWithinDays` is what a shop actually acts on — it is the difference
 * between discounting something and throwing it away.
 */
export async function getBatchSummary(itemId, { expiringWithinDays = 7, now = new Date() } = {}) {
    if (!mongoose.Types.ObjectId.isValid(String(itemId))) throw new NotFoundError('Product not found');

    // Same computed key as the picker, so what a shop is shown is the order it
    // will actually be picked in.
    const batches = await FoodStockBatch.aggregate([
        { $match: { itemId: oid(itemId), status: 'active', remainingQty: { $gt: 0 } } },
        { $addFields: { expirySortKey: { $ifNull: ['$expiryDate', new Date('9999-12-31T00:00:00.000Z')] } } },
        { $sort: { expirySortKey: 1, receivedAt: 1 } },
    ]);

    const soonCutoff = new Date(now.getTime() + expiringWithinDays * 24 * 60 * 60 * 1000);

    return {
        itemId: String(itemId),
        totalRemaining: batches.reduce((sum, b) => sum + (Number(b.remainingQty) || 0), 0),
        expiringSoon: batches
            .filter((b) => b.expiryDate && new Date(b.expiryDate) <= soonCutoff)
            .reduce((sum, b) => sum + (Number(b.remainingQty) || 0), 0),
        batches: batches.map((b) => ({
            id: String(b._id),
            batchNo: b.batchNo || '',
            expiryDate: b.expiryDate || null,
            remainingQty: b.remainingQty,
            receivedQty: b.receivedQty,
            purchasePrice: b.purchasePrice ?? null,
            receivedAt: b.receivedAt,
            // Negative means it is already past, which the sweep will clear.
            daysToExpiry: b.expiryDate
                ? Math.ceil((new Date(b.expiryDate).getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
                : null,
        })),
    };
}

/** Everything about to go off across a shop, for the people who can act on it. */
export async function listExpiringBatches({ restaurantId = null, withinDays = 7, now = new Date() } = {}) {
    const filter = {
        status: 'active',
        remainingQty: { $gt: 0 },
        expiryDate: { $ne: null, $lte: new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000) },
    };
    if (restaurantId && mongoose.Types.ObjectId.isValid(String(restaurantId))) {
        filter.restaurantId = oid(restaurantId);
    }

    const batches = await FoodStockBatch.find(filter).sort({ expiryDate: 1 }).limit(500).lean();
    if (batches.length === 0) return { withinDays, batches: [] };

    const items = await FoodItem.find({ _id: { $in: batches.map((b) => b.itemId) } })
        .select('name itemCode')
        .lean();
    const byId = new Map(items.map((i) => [String(i._id), i]));

    return {
        withinDays,
        batches: batches.map((b) => ({
            id: String(b._id),
            itemId: String(b.itemId),
            name: byId.get(String(b.itemId))?.name || '',
            itemCode: byId.get(String(b.itemId))?.itemCode || '',
            batchNo: b.batchNo || '',
            expiryDate: b.expiryDate,
            remainingQty: b.remainingQty,
            daysToExpiry: Math.ceil((new Date(b.expiryDate).getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
        })),
    };
}
