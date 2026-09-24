import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb } from './helpers/db.js';
import { FoodUser } from '../src/core/users/user.model.js';
import { FoodUserWallet } from '../src/modules/food/user/models/userWallet.model.js';
import { getCustomers, getCustomerById } from '../src/modules/food/admin/services/admin.service.js';

/**
 * The customer's wallet, as admin sees it.
 *
 * "Admin can see the wallet" splits into two different questions the panel
 * answers differently: the list is a glance -- who is carrying a balance --
 * and the detail view is an audit -- where every rupee of it came from. A
 * balance with no transaction history answers the first question and fails
 * the second.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const aCustomer = (over = {}) =>
    FoodUser.create({
        phone: '9800000001',
        name: 'Asha Verma',
        role: 'USER',
        ...over
    });

describe('the customer list', () => {
    it('carries each customer’s wallet balance', async () => {
        const rich = await aCustomer({ phone: '9800000001', name: 'Rich Customer' });
        const poor = await aCustomer({ phone: '9800000002', name: 'No Wallet Yet' });
        await FoodUserWallet.create({ userId: rich._id, balance: 450 });

        const { customers } = await getCustomers({});
        const byName = Object.fromEntries(customers.map((c) => [c.name, c.walletBalance]));

        assert.equal(byName['Rich Customer'], 450);
        // Never having topped up is 0, not a crash and not "undefined" leaking
        // into a currency column.
        assert.equal(byName['No Wallet Yet'], 0);
    });

    it('is unaffected by an unrelated customer’s wallet', async () => {
        const a = await aCustomer({ phone: '9800000003', name: 'A' });
        const b = await aCustomer({ phone: '9800000004', name: 'B' });
        await FoodUserWallet.create({ userId: a._id, balance: 999 });

        const { customers } = await getCustomers({});
        assert.equal(customers.find((c) => c.name === 'B').walletBalance, 0);
    });
});

describe('the customer detail view', () => {
    it('shows the running balance and referral earnings', async () => {
        const user = await aCustomer();
        await FoodUserWallet.create({ userId: user._id, balance: 320, referralEarnings: 50 });

        const detail = await getCustomerById(String(user._id));
        assert.equal(detail.walletBalance, 320);
        assert.equal(detail.walletReferralEarnings, 50);
    });

    it('shows the full transaction history, newest first', async () => {
        const user = await aCustomer();
        await FoodUserWallet.create({
            userId: user._id,
            balance: 150,
            transactions: [
                { type: 'addition', amount: 200, description: 'Wallet top-up', createdAt: new Date('2026-09-01') },
                { type: 'deduction', amount: 50, description: 'Order payment', createdAt: new Date('2026-09-10') },
            ],
        });

        const detail = await getCustomerById(String(user._id));
        assert.equal(detail.walletTransactions.length, 2);
        assert.deepEqual(
            detail.walletTransactions.map((t) => t.description),
            ['Order payment', 'Wallet top-up'],
            'the most recent entry is what an admin looking up a dispute wants first'
        );
        assert.equal(detail.walletTransactions[0].amount, 50);
        assert.equal(detail.walletTransactions[0].type, 'deduction');
    });

    it('does not error for a customer who never had a wallet document created', async () => {
        // A wallet document is created lazily on first top-up or spend; a
        // customer who has only ever browsed has none at all.
        const user = await aCustomer();

        const detail = await getCustomerById(String(user._id));
        assert.equal(detail.walletBalance, 0);
        assert.equal(detail.walletReferralEarnings, 0);
        assert.deepEqual(detail.walletTransactions, []);
    });
});

describe('the statement — a running balance per entry', () => {
    it('carries the balance the account actually had right after each entry', async () => {
        // Topped up 200, spent 60, then got a 20 refund. Final balance: 160.
        const user = await aCustomer();
        await FoodUserWallet.create({
            userId: user._id,
            balance: 160,
            transactions: [
                { type: 'addition', amount: 200, description: 'Wallet top-up', createdAt: new Date('2026-09-01T10:00:00Z') },
                { type: 'deduction', amount: 60, description: 'Order payment', createdAt: new Date('2026-09-02T10:00:00Z') },
                { type: 'refund', amount: 20, description: 'Order refund', createdAt: new Date('2026-09-03T10:00:00Z') },
            ],
        });

        const detail = await getCustomerById(String(user._id));
        // Newest first: refund, deduction, addition.
        const [refundRow, deductionRow, additionRow] = detail.walletTransactions;

        assert.equal(refundRow.balanceAfter, 160, 'the balance right now, after the newest entry');
        assert.equal(deductionRow.balanceAfter, 140, 'balance after the spend, before the refund');
        assert.equal(additionRow.balanceAfter, 200, 'balance right after the top-up, before anything was spent');

        // What the statement had before its very first entry.
        assert.equal(detail.walletOpeningBalance, 0);
    });

    it('starts the opening balance from whatever the account already held', async () => {
        // A wallet that had a balance before this stretch of history began --
        // an opening balance that is not zero.
        const user = await aCustomer();
        await FoodUserWallet.create({
            userId: user._id,
            balance: 350,
            transactions: [
                { type: 'addition', amount: 100, description: 'Top-up', createdAt: new Date('2026-09-05') },
            ],
        });

        const detail = await getCustomerById(String(user._id));
        assert.equal(detail.walletTransactions[0].balanceAfter, 350);
        assert.equal(detail.walletOpeningBalance, 250, 'balance already there before this entry');
    });

    it('has no rows and a zero opening balance for a wallet with no history', async () => {
        const user = await aCustomer();
        await FoodUserWallet.create({ userId: user._id, balance: 0 });

        const detail = await getCustomerById(String(user._id));
        assert.deepEqual(detail.walletTransactions, []);
        assert.equal(detail.walletOpeningBalance, 0);
    });
});
