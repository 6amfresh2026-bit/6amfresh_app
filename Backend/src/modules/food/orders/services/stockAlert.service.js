import { FoodItem } from '../../admin/models/food.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { stockTier, STOCK_TIER_LABELS, shouldAlertForTierChange } from '../../shared/stockTiers.js';
import { notifyOwnersActionableAlert } from './order.helpers.js';
import { logger } from '../../../../utils/logger.js';

/**
 * Tells the shop when a product falls into a worse stock tier.
 *
 * Fires on the *crossing*, not on the state: a shop selling forty units of a
 * low item in a morning needs one notice, not forty. The tier the item was
 * last seen in is recorded on the item itself, so the comparison survives
 * restarts and does not need a cache.
 *
 * Only downward moves alert. Restocking back into "in stock" is good news and
 * nobody needs waking for it — and a channel that pings in both directions is
 * a channel that gets muted, which costs the alerts that mattered.
 *
 * Never awaited by the order path. A push that fails must not fail a sale.
 */
export async function notifyStockTierChange(item) {
    if (!item?._id) return null;

    try {
        // The outlet supplies the thresholds this product has not overridden.
        const outlet = item.restaurantId
            ? await FoodRestaurant.findById(item.restaurantId).select('stockThresholds restaurantName name').lean()
            : null;

        const nextTier = stockTier(item, outlet);
        const previousTier = item.stockAlert?.lastTier ?? 'in_stock';

        if (nextTier === previousTier) return null;

        // The tier is recorded whichever way it moved, so a restock resets the
        // baseline and the next fall alerts again.
        await FoodItem.updateOne(
            { _id: item._id },
            { $set: { 'stockAlert.lastTier': nextTier } },
        );

        if (!shouldAlertForTierChange(previousTier, nextTier)) return null;

        await FoodItem.updateOne(
            { _id: item._id },
            { $set: { 'stockAlert.lastNotifiedAt': new Date() } },
        );

        const label = STOCK_TIER_LABELS[nextTier];
        const remaining = Number(item.stockQty) || 0;
        const body = nextTier === 'out'
            ? `${item.name} is out of stock.`
            : `${item.name} — ${remaining} left.`;

        if (item.restaurantId) {
            await notifyOwnersActionableAlert(
                [{ ownerType: 'RESTAURANT', ownerId: String(item.restaurantId) }],
                {
                    title: `${label}: ${item.name}`,
                    body,
                    data: {
                        type: 'stock_alert',
                        tier: nextTier,
                        itemId: String(item._id),
                        remaining: String(remaining),
                    },
                },
            );
        }

        logger.info(`Stock alert: ${item.name} moved ${previousTier} -> ${nextTier} (${remaining} left)`);
        return { itemId: String(item._id), from: previousTier, to: nextTier, remaining };
    } catch (err) {
        logger.warn(`Stock alert failed for item ${item?._id}: ${err?.message || err}`);
        return null;
    }
}
