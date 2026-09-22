import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveStockThresholds,
    stockTier,
    stockBadge,
    shouldAlertForTierChange,
    DEFAULT_STOCK_THRESHOLDS,
} from '../src/modules/food/shared/stockTiers.js';

/**
 * Which stock tier an item is in.
 *
 * Pure, so it is tested without a database: the value of having one
 * implementation is that the admin screen, the seller list, the storefront
 * card and the alert all agree, and that only holds if the rules here are
 * pinned down.
 */

const OUTLET = { stockThresholds: { low: 20, critical: 5, out: 1 } };

describe('where the thresholds come from', () => {
    it('uses the product’s own numbers when it has them', () => {
        const t = resolveStockThresholds(
            { lowStockThreshold: 8, criticalStockThreshold: 2, outOfStockThreshold: 0 },
            OUTLET,
        );
        assert.deepEqual(t, { low: 8, critical: 2, out: 0 });
    });

    it('falls back to the outlet for the ones it has not set', () => {
        // The whole point: a shop configures once, and overrides only the SKUs
        // that genuinely differ.
        const t = resolveStockThresholds({ lowStockThreshold: 8 }, OUTLET);
        assert.deepEqual(t, { low: 8, critical: 5, out: 1 });
    });

    it('falls back to the platform defaults with no outlet at all', () => {
        const t = resolveStockThresholds({});
        assert.deepEqual(t, {
            low: DEFAULT_STOCK_THRESHOLDS.low,
            critical: DEFAULT_STOCK_THRESHOLDS.critical,
            out: DEFAULT_STOCK_THRESHOLDS.out,
        });
    });

    it('clamps a critical line somebody set above the low line', () => {
        // Otherwise nothing would ever be critical and everything under low
        // would be critical at the same time.
        const t = resolveStockThresholds(
            { lowStockThreshold: 5, criticalStockThreshold: 50, outOfStockThreshold: 99 },
            null,
        );
        assert.equal(t.critical, 5);
        assert.ok(t.out <= t.critical);
    });
});

describe('the tier an item is in', () => {
    const at = (qty) => stockTier({ stockQty: qty }, OUTLET);

    it('reads the boundaries as "at or below"', () => {
        assert.equal(at(21), 'in_stock');
        assert.equal(at(20), 'low', 'exactly on the low line is low');
        assert.equal(at(6), 'low');
        assert.equal(at(5), 'critical', 'exactly on the critical line is critical');
        assert.equal(at(2), 'critical');
        assert.equal(at(1), 'out', 'a shop that refuses to sell its last unit sets out to 1');
        assert.equal(at(0), 'out');
    });

    it('does not call an untracked item out of stock', () => {
        // null stock means nobody counts this item, which is not the same as
        // having none of it. Badging it "out of stock" would hide a product
        // that is perfectly available.
        assert.equal(stockTier({ stockQty: null }, OUTLET), 'untracked');
        assert.equal(stockTier({}, OUTLET), 'untracked');
        assert.equal(stockTier({ stockQty: 'nonsense' }, OUTLET), 'untracked');
    });
});

describe('what a card is given to render', () => {
    it('carries the number, not just the word', () => {
        // "Low stock" alone tells a buyer nothing about whether to hurry and a
        // shop nothing about what to reorder.
        const badge = stockBadge({ stockQty: 3, name: 'Chocolate Brownie' }, OUTLET);
        assert.equal(badge.tier, 'critical');
        assert.equal(badge.label, 'Critical stock');
        assert.equal(badge.remaining, 3);
        assert.equal(badge.needsAttention, true);
    });

    it('asks for no attention when there is plenty', () => {
        const badge = stockBadge({ stockQty: 500 }, OUTLET);
        assert.equal(badge.tier, 'in_stock');
        assert.equal(badge.needsAttention, false);
    });

    it('reports no quantity for an untracked item', () => {
        assert.equal(stockBadge({ stockQty: null }, OUTLET).remaining, null);
    });
});

describe('when an alert should fire', () => {
    it('fires on the way down', () => {
        assert.equal(shouldAlertForTierChange('in_stock', 'low'), true);
        assert.equal(shouldAlertForTierChange('low', 'critical'), true);
        assert.equal(shouldAlertForTierChange('critical', 'out'), true);
        assert.equal(shouldAlertForTierChange('in_stock', 'out'), true, 'a big sale can skip tiers');
    });

    it('stays quiet on the way back up', () => {
        // A channel that pings in both directions gets muted, which costs the
        // alerts that mattered.
        assert.equal(shouldAlertForTierChange('out', 'in_stock'), false);
        assert.equal(shouldAlertForTierChange('critical', 'low'), false);
    });

    it('stays quiet when nothing changed', () => {
        // The reason the last tier is stored at all: a shop selling forty units
        // of a low item in a morning needs one notice, not forty.
        assert.equal(shouldAlertForTierChange('low', 'low'), false);
        assert.equal(shouldAlertForTierChange('in_stock', 'in_stock'), false);
    });

    it('never alerts for an untracked item', () => {
        assert.equal(shouldAlertForTierChange('in_stock', 'untracked'), false);
    });
});
