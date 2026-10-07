/**
 * The low-stock alert email, built in isolation.
 *
 * This is the pure half of the feature: given a product's stock figures it
 * returns a subject, an HTML body and the recipient list, with no SMTP and no
 * database in reach. Testing it here means the wording, the out-of-stock vs
 * low-stock split, the optional rows and — most importantly — who the mail is
 * addressed to are all pinned down without a mail server, which the unit lane
 * on CI does not have.
 *
 *   node scripts/lowStockEmail.selfcheck.mjs
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// config/env.js reads process.env once, at import. Set the central inbox(es)
// before importing so recipient resolution has something to resolve.
process.env.STOCK_ALERT_EMAIL = 'alerts@6amfresh.test, ops@6amfresh.test';

let buildLowStockAlertEmail;
let resolveStockAlertRecipients;

before(async () => {
    ({ buildLowStockAlertEmail, resolveStockAlertRecipients } = await import('../src/utils/email.js'));
});

describe('resolveStockAlertRecipients', () => {
    it('splits STOCK_ALERT_EMAIL on commas and trims each address', () => {
        assert.deepEqual(resolveStockAlertRecipients(), [
            'alerts@6amfresh.test',
            'ops@6amfresh.test',
        ]);
    });

    it('adds the seller address after the central inbox when one is given', () => {
        assert.deepEqual(resolveStockAlertRecipients('seller@shop.test'), [
            'alerts@6amfresh.test',
            'ops@6amfresh.test',
            'seller@shop.test',
        ]);
    });

    it('drops empty / missing addresses rather than mailing ""', () => {
        assert.deepEqual(resolveStockAlertRecipients(''), [
            'alerts@6amfresh.test',
            'ops@6amfresh.test',
        ]);
    });
});

describe('buildLowStockAlertEmail — low but not empty', () => {
    const mail = () =>
        buildLowStockAlertEmail({
            productName: 'Fresh Milk 1L',
            currentStock: 6,
            threshold: 10,
            sku: 'MILK-1L',
            unit: 'units',
            sellerName: 'Corner Store',
            sellerEmail: 'seller@shop.test',
            price: 60,
        });

    it('is flagged low, not out', () => {
        assert.equal(mail().isOut, false);
    });

    it('subject names the state, the product and the seller', () => {
        const { subject } = mail();
        assert.match(subject, /Low stock/i);
        assert.match(subject, /Fresh Milk 1L/);
        assert.match(subject, /Corner Store/);
    });

    it('body carries the low badge, the figures and the optional rows', () => {
        const { html } = mail();
        assert.match(html, /LOW STOCK/);
        assert.doesNotMatch(html, /OUT OF STOCK/);
        assert.match(html, /6 units/);          // current stock + unit
        assert.match(html, /10 units/);         // threshold + unit
        assert.match(html, /MILK-1L/);          // sku row present
        assert.match(html, /Corner Store/);     // seller row present
        assert.match(html, /Rs\. 60/);          // price row present
    });

    it('addresses the central inbox and the seller', () => {
        assert.deepEqual(mail().recipients, [
            'alerts@6amfresh.test',
            'ops@6amfresh.test',
            'seller@shop.test',
        ]);
    });
});

describe('buildLowStockAlertEmail — out of stock', () => {
    const mail = () =>
        buildLowStockAlertEmail({ productName: 'Brown Bread', currentStock: 0, threshold: 5 });

    it('is flagged out when stock has hit zero', () => {
        assert.equal(mail().isOut, true);
    });

    it('zero or below reads as out, never low', () => {
        assert.equal(buildLowStockAlertEmail({ currentStock: -2 }).isOut, true);
    });

    it('subject and body say out of stock', () => {
        const { subject, html } = mail();
        assert.match(subject, /Out of stock/i);
        assert.match(html, /OUT OF STOCK/);
        assert.doesNotMatch(html, />LOW STOCK</);
    });
});

describe('buildLowStockAlertEmail — optional rows are omitted when absent', () => {
    it('leaves out the sku, seller and price rows entirely', () => {
        const { html } = buildLowStockAlertEmail({
            productName: 'Plain Item',
            currentStock: 3,
            threshold: 10,
        });
        assert.doesNotMatch(html, /SKU/);
        assert.doesNotMatch(html, /Seller/);
        assert.doesNotMatch(html, /Price/);
        // the always-present rows still render
        assert.match(html, /Current stock/);
        assert.match(html, /Low-stock threshold/);
    });

    it('falls back to a generic product name when none is given', () => {
        assert.match(buildLowStockAlertEmail({}).subject, /Product/);
    });
});
