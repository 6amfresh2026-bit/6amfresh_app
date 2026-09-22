/**
 * Which stock tier an item is in, and what to call it.
 *
 * One implementation, because the answer has to be identical in four places —
 * the admin stock screen, the seller's product list, the storefront card and
 * the alert that fires when it changes. Four hand-written comparisons drift,
 * and a product that reads "Low stock" on one screen and "In stock" on another
 * is worse than no badge at all.
 *
 * Thresholds resolve product-first, then outlet, then these defaults, so a shop
 * configures once and overrides only the SKUs that genuinely differ.
 */

export const STOCK_TIERS = Object.freeze(['out', 'critical', 'low', 'in_stock']);

export const DEFAULT_STOCK_THRESHOLDS = Object.freeze({ low: 10, critical: 3, out: 0 });

export const STOCK_TIER_LABELS = Object.freeze({
    untracked: 'Not tracked',
    in_stock: 'In stock',
    low: 'Low stock',
    critical: 'Critical stock',
    out: 'Out of stock',
});

const firstNumber = (...values) => {
    for (const v of values) {
        if (v === null || v === undefined || v === '') continue;
        const n = Number(v);
        if (Number.isFinite(n)) return n;
    }
    return null;
};

/**
 * The three numbers that apply to one product.
 *
 * `outlet` is the restaurant document (or just its stockThresholds); passing
 * nothing falls back to the defaults, which is what a product with no outlet
 * loaded should see rather than an exception.
 */
export function resolveStockThresholds(product = {}, outlet = null) {
    const o = outlet?.stockThresholds || outlet || {};
    const low = firstNumber(product.lowStockThreshold, o.low, DEFAULT_STOCK_THRESHOLDS.low);
    const critical = firstNumber(product.criticalStockThreshold, o.critical, DEFAULT_STOCK_THRESHOLDS.critical);
    const out = firstNumber(product.outOfStockThreshold, o.out, DEFAULT_STOCK_THRESHOLDS.out);

    // A critical line above the low line would classify nothing as critical and
    // everything below low as critical at the same time. Clamping is kinder
    // than refusing: the shop typed something confusing, not something fatal.
    return { low, critical: Math.min(critical, low), out: Math.min(out, Math.min(critical, low)) };
}

/**
 * The tier, given a quantity.
 *
 * `null`/undefined stock means the item is not stock-tracked at all, which is
 * not the same as having none of it — an untracked item must never be badged
 * "out of stock".
 */
export function stockTier(product = {}, outlet = null) {
    const qty = product.stockQty;
    if (qty === null || qty === undefined || qty === '') return 'untracked';
    const n = Number(qty);
    if (!Number.isFinite(n)) return 'untracked';

    const { low, critical, out } = resolveStockThresholds(product, outlet);
    if (n <= out) return 'out';
    if (n <= critical) return 'critical';
    if (n <= low) return 'low';
    return 'in_stock';
}

/** Everything a card needs to render the badge, in one call. */
export function stockBadge(product = {}, outlet = null) {
    const tier = stockTier(product, outlet);
    return {
        tier,
        label: STOCK_TIER_LABELS[tier],
        // The number is the point of the badge: "Low stock" alone does not tell
        // a buyer whether to hurry, and does not tell a shop what to reorder.
        remaining: tier === 'untracked' ? null : Number(product.stockQty) || 0,
        needsAttention: tier === 'low' || tier === 'critical' || tier === 'out',
        thresholds: resolveStockThresholds(product, outlet),
    };
}

/** Rank so "has it got worse?" is a comparison rather than a lookup table. */
const SEVERITY = { in_stock: 0, low: 1, critical: 2, out: 3, untracked: -1 };

/**
 * Whether crossing from `previous` into `next` is worth telling somebody.
 *
 * Only downward moves alert. Restocking back up to "in stock" is good news
 * nobody needs woken for, and alerting on every direction is how a channel
 * gets muted.
 */
export function shouldAlertForTierChange(previous, next) {
    if (!SEVERITY[next] || SEVERITY[next] <= 0) return false;
    const before = SEVERITY[previous] ?? 0;
    return SEVERITY[next] > before;
}
