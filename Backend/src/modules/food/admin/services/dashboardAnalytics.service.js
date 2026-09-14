import mongoose from 'mongoose';

import { FoodOrder } from '../../orders/models/order.model.js';
import { FoodUser } from '../../../../core/users/user.model.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * Dashboard analytics: top customers, customer segments, and category and
 * product sales.
 *
 * Everything is computed from order lines rather than from the live catalogue.
 * The lines snapshot the product name, category and unit cost as they were when
 * the sale happened, so a rename, a re-categorisation or a price change cannot
 * rewrite last month's numbers — which is the whole point of a sales report.
 *
 * Profit is `(unit price − unit cost) × quantity`, using the cost snapshotted on
 * the line. Orders placed before that snapshot existed carry no cost, and their
 * profit is reported as zero rather than guessed from today's price list.
 */

/**
 * Orders that represent money actually taken.
 *
 * The excluded statuses are spelled exactly as the order schema's enum defines
 * them. A near-miss here fails silently — Mongo matches nothing, `$nin` excludes
 * nothing, and cancelled orders quietly inflate every figure on the dashboard.
 */
const EXCLUDED_ORDER_STATUSES = [
    'pending_payment',
    'cancelled_by_user',
    'cancelled_by_restaurant',
    'cancelled_by_admin'
];

const SETTLED_ORDER_MATCH = {
    orderStatus: { $nin: EXCLUDED_ORDER_STATUSES },
    $or: [
        { 'payment.method': { $in: ['cash', 'wallet'] } },
        // Spelled from the payment schema's enum. 'refunded' is deliberately
        // absent: the money went back, so the sale is not revenue.
        { 'payment.status': { $in: ['paid', 'authorized'] } }
    ]
};

/**
 * Reads a from/to pair as local calendar days, inclusive.
 *
 * Built from the date parts rather than parsed as an ISO instant: `new
 * Date('2026-09-01')` is UTC midnight, which lands on the previous day for any
 * timezone behind UTC and would silently shift every report by a day.
 */
const parseDay = (raw, endOfDay = false) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw || '').trim());
    if (!m) throw new ValidationError('Dates must be in YYYY-MM-DD format');
    const [, y, mo, d] = m;
    return endOfDay
        ? new Date(+y, +mo - 1, +d, 23, 59, 59, 999)
        : new Date(+y, +mo - 1, +d, 0, 0, 0, 0);
};

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date, n) => { const d = new Date(date); d.setDate(d.getDate() + n); return d; };

/** Defaults to the current calendar month, which is what the widgets open on. */
const dateRange = (query = {}) => {
    const now = new Date();
    const start = query.from ? parseDay(query.from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = query.to ? parseDay(query.to, true) : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    if (start > end) throw new ValidationError('"from" cannot be after "to"');
    return { start, end };
};

const baseMatch = (query = {}) => {
    const { start, end } = dateRange(query);
    const match = { ...SETTLED_ORDER_MATCH, createdAt: { $gte: start, $lte: end } };
    if (query.restaurantId) {
        if (!mongoose.Types.ObjectId.isValid(String(query.restaurantId))) {
            throw new ValidationError('Invalid restaurantId');
        }
        match.restaurantId = new mongoose.Types.ObjectId(String(query.restaurantId));
    }
    if (query.zoneId && mongoose.Types.ObjectId.isValid(String(query.zoneId))) {
        match.zoneId = new mongoose.Types.ObjectId(String(query.zoneId));
    }
    return { match, start, end };
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Line value and line profit, shared by the category and product pipelines. */
const LINE_AMOUNT = { $multiply: [{ $ifNull: ['$items.price', 0] }, { $ifNull: ['$items.quantity', 0] }] };
const LINE_PROFIT = {
    $cond: [
        { $eq: [{ $ifNull: ['$items.purchasePrice', null] }, null] },
        0,
        {
            $multiply: [
                { $subtract: [{ $ifNull: ['$items.price', 0] }, { $ifNull: ['$items.purchasePrice', 0] }] },
                { $ifNull: ['$items.quantity', 0] }
            ]
        }
    ]
};

/** Each row's share of the period's total, so the column sums to ~100. */
const withSharePercent = (rows, key = 'salesAmount') => {
    const total = rows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0);
    return rows.map((r) => ({
        ...r,
        salesPercent: total > 0 ? round2((Number(r[key]) || 0) * 100 / total) : 0
    }));
};

// ───────────────────────────── Top customers ─────────────────────────────

export async function getTopCustomers(query = {}) {
    const { match, start, end } = baseMatch(query);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);

    const rows = await FoodOrder.aggregate([
        { $match: match },
        {
            $group: {
                _id: '$userId',
                bills: { $sum: 1 },
                salesValue: { $sum: { $ifNull: ['$pricing.total', 0] } }
            }
        },
        { $sort: { salesValue: -1, bills: -1 } },
        { $limit: limit }
    ]);

    const users = rows.length
        ? await FoodUser.find({ _id: { $in: rows.map((r) => r._id).filter(Boolean) } })
            .select('name fullName phone')
            .lean()
        : [];
    const byId = new Map(users.map((u) => [String(u._id), u]));

    return {
        from: start,
        to: end,
        customers: rows.map((r, i) => {
            const u = byId.get(String(r._id));
            return {
                rank: i + 1,
                customerId: r._id ? String(r._id) : null,
                customerName: u?.name || u?.fullName || 'Unknown customer',
                phone: u?.phone || '',
                bills: r.bills,
                salesValue: round2(r.salesValue)
            };
        })
    };
}

// ─────────────────────────── Customer segments ───────────────────────────

/**
 * Buckets every customer who has ever ordered, by how recently they last did.
 *
 * Recency, not spend, is what the four labels describe: a customer who bought a
 * lot last year and nothing since is lost, however much they spent. VIP is the
 * one bucket that also looks at value — recent *and* worth more than the
 * threshold — because "VIP" without a value test is just "active".
 *
 * The windows are inputs rather than constants so the meaning can be tuned per
 * business without a deploy.
 */
export async function getCustomerSegments(query = {}) {
    const activeDays = Math.max(parseInt(query.activeDays, 10) || 30, 1);
    const riskDays = Math.max(parseInt(query.riskDays, 10) || 90, activeDays + 1);
    const vipMinSpend = Number(query.vipMinSpend ?? 5000);
    const vipMinOrders = Math.max(parseInt(query.vipMinOrders, 10) || 5, 1);

    const today = startOfDay(new Date());
    const activeSince = addDays(today, -activeDays);
    const riskSince = addDays(today, -riskDays);

    const match = { ...SETTLED_ORDER_MATCH };
    if (query.restaurantId && mongoose.Types.ObjectId.isValid(String(query.restaurantId))) {
        match.restaurantId = new mongoose.Types.ObjectId(String(query.restaurantId));
    }

    const rows = await FoodOrder.aggregate([
        { $match: match },
        {
            $group: {
                _id: '$userId',
                lastOrderAt: { $max: '$createdAt' },
                orders: { $sum: 1 },
                spend: { $sum: { $ifNull: ['$pricing.total', 0] } }
            }
        },
        {
            $addFields: {
                segment: {
                    $switch: {
                        branches: [
                            {
                                case: {
                                    $and: [
                                        { $gte: ['$lastOrderAt', activeSince] },
                                        {
                                            $or: [
                                                { $gte: ['$spend', vipMinSpend] },
                                                { $gte: ['$orders', vipMinOrders] }
                                            ]
                                        }
                                    ]
                                },
                                then: 'vip'
                            },
                            { case: { $gte: ['$lastOrderAt', activeSince] }, then: 'regular' },
                            { case: { $gte: ['$lastOrderAt', riskSince] }, then: 'risk' }
                        ],
                        default: 'lost'
                    }
                }
            }
        },
        { $group: { _id: '$segment', count: { $sum: 1 } } }
    ]);

    const counts = { vip: 0, regular: 0, risk: 0, lost: 0 };
    for (const r of rows) if (r._id in counts) counts[r._id] = r.count;

    return {
        counts,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        rules: {
            activeDays,
            riskDays,
            vipMinSpend,
            vipMinOrders,
            describe: {
                vip: `ordered in the last ${activeDays} days and has spent ≥ ${vipMinSpend} or placed ≥ ${vipMinOrders} orders`,
                regular: `ordered in the last ${activeDays} days`,
                risk: `last ordered ${activeDays}–${riskDays} days ago`,
                lost: `last ordered more than ${riskDays} days ago`
            }
        }
    };
}

// ───────────────────────────── Category sales ─────────────────────────────

export async function getCategorySales(query = {}) {
    const { match, start, end } = baseMatch(query);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);

    const rows = await FoodOrder.aggregate([
        { $match: match },
        { $unwind: '$items' },
        {
            $group: {
                // Grouped by the snapshotted name: an uncategorised line still
                // belongs somewhere, and two ids that were renamed to the same
                // thing read as one row, which is what the reader expects.
                _id: { $ifNull: ['$items.categoryName', ''] },
                categoryId: { $first: '$items.categoryId' },
                salesQty: { $sum: { $ifNull: ['$items.quantity', 0] } },
                salesAmount: { $sum: LINE_AMOUNT },
                profit: { $sum: LINE_PROFIT }
            }
        },
        { $sort: { salesAmount: -1 } },
        { $limit: limit }
    ]);

    const categories = withSharePercent(
        rows.map((r) => ({
            categoryId: r.categoryId ? String(r.categoryId) : null,
            categoryName: r._id || 'Uncategorised',
            salesQty: r.salesQty,
            salesAmount: round2(r.salesAmount),
            profit: round2(r.profit)
        }))
    );

    return { from: start, to: end, categories };
}

// ───────────────────────────── Product sales ─────────────────────────────

/**
 * Best- or least-selling products for the period.
 *
 * "Least selling" means the weakest of what actually sold — a product with no
 * sales at all has no order lines and so cannot appear. That matches the
 * reference, and it is the more useful reading: a list of everything never
 * bought is the catalogue, not a report.
 */
export async function getProductSales(query = {}) {
    const { match, start, end } = baseMatch(query);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 10, 1), 100);
    const direction = String(query.order || 'best').toLowerCase() === 'least' ? 1 : -1;

    const rows = await FoodOrder.aggregate([
        { $match: match },
        { $unwind: '$items' },
        {
            $group: {
                _id: { $ifNull: ['$items.itemId', '$items.name'] },
                productName: { $first: '$items.name' },
                image: { $first: '$items.image' },
                // One bill per order, however many lines of the product it had.
                billIds: { $addToSet: '$_id' },
                salesQty: { $sum: { $ifNull: ['$items.quantity', 0] } },
                salesAmount: { $sum: LINE_AMOUNT },
                profit: { $sum: LINE_PROFIT }
            }
        },
        { $addFields: { bills: { $size: '$billIds' } } },
        { $project: { billIds: 0 } },
        { $sort: { salesQty: direction, salesAmount: direction } },
        { $limit: limit }
    ]);

    // The share is of the period's whole product sales, so "best" and "least"
    // report the same denominator and can be read side by side.
    const totalRow = await FoodOrder.aggregate([
        { $match: match },
        { $unwind: '$items' },
        { $group: { _id: null, salesAmount: { $sum: LINE_AMOUNT } } }
    ]);
    const periodTotal = totalRow[0]?.salesAmount || 0;

    return {
        from: start,
        to: end,
        order: direction === 1 ? 'least' : 'best',
        products: rows.map((r) => ({
            productId: r._id ? String(r._id) : null,
            productName: r.productName || 'Unknown product',
            image: r.image || '',
            bills: r.bills,
            salesQty: r.salesQty,
            salesAmount: round2(r.salesAmount),
            profit: round2(r.profit),
            salesPercent: periodTotal > 0 ? round2(r.salesAmount * 100 / periodTotal) : 0
        }))
    };
}

/** Everything the dashboard needs, in one round trip. */
// ───────────────────────────── Delivery promise ─────────────────────────────

/**
 * How often the promise was kept, over the period.
 *
 * Scored against `promise.dueBy` — the deadline built from the minutes the
 * customer was actually shown before they committed — rather than from today's
 * distance and constants. Recomputing would answer a different question: what
 * we *would* quote now, not what we said then.
 *
 * Deliberately NOT filtered by SETTLED_ORDER_MATCH. That excludes cancellations
 * to keep money figures honest, but the promise is about arrival, not revenue:
 * a COD order still awaiting its cash line was still delivered on time or it
 * was not. Orders carrying no promise — everything placed before the field
 * existed, counter sales, administratively closed trips — settle as
 * 'not_applicable' and are reported separately rather than folded into the
 * rate, so the denominator is only orders that actually made a promise.
 */
export async function getPromisePerformance(query = {}) {
    const { start, end } = dateRange(query);
    const match = { createdAt: { $gte: start, $lte: end } };
    if (query.restaurantId) {
        if (!mongoose.Types.ObjectId.isValid(String(query.restaurantId))) {
            throw new ValidationError('Invalid restaurantId');
        }
        match.restaurantId = new mongoose.Types.ObjectId(String(query.restaurantId));
    }
    if (query.zoneId && mongoose.Types.ObjectId.isValid(String(query.zoneId))) {
        match.zoneId = new mongoose.Types.ObjectId(String(query.zoneId));
    }

    const rows = await FoodOrder.aggregate([
        { $match: match },
        {
            $group: {
                _id: { $ifNull: ['$promise.outcome', 'not_applicable'] },
                orders: { $sum: 1 },
                // Averaged over the scored orders only; a pending or
                // inapplicable order has no variance to contribute.
                totalVariance: { $sum: { $ifNull: ['$promise.varianceSeconds', 0] } },
                quotedMinutes: { $sum: { $ifNull: ['$promise.quotedMinutes', 0] } },
                worstLateSeconds: { $max: { $ifNull: ['$promise.varianceSeconds', 0] } }
            }
        }
    ]);

    const by = new Map(rows.map((r) => [String(r._id), r]));
    const onTime = by.get('on_time')?.orders || 0;
    const late = by.get('late')?.orders || 0;
    const pending = by.get('pending')?.orders || 0;
    const notApplicable = by.get('not_applicable')?.orders || 0;
    const scored = onTime + late;

    const varianceSum = (by.get('on_time')?.totalVariance || 0) + (by.get('late')?.totalVariance || 0);
    const quotedSum = (by.get('on_time')?.quotedMinutes || 0) + (by.get('late')?.quotedMinutes || 0);

    return {
        from: start,
        to: end,
        scored,
        onTime,
        late,
        /** Still in flight — reported so a small denominator is visible, not hidden. */
        pending,
        /** No promise to keep: counter sales, pre-feature orders, admin closes. */
        notApplicable,
        onTimePercent: scored > 0 ? round2((onTime * 100) / scored) : null,
        avgQuotedMinutes: scored > 0 ? round2(quotedSum / scored) : null,
        /** Negative is early. Minutes, signed, averaged over scored orders. */
        avgVarianceMinutes: scored > 0 ? round2(varianceSum / scored / 60) : null,
        worstLateMinutes: late > 0 ? round2((by.get('late')?.worstLateSeconds || 0) / 60) : null
    };
}

export async function getDashboardAnalytics(query = {}) {
    const [topCustomers, segments, categorySales, bestSelling, leastSelling, promise] = await Promise.all([
        getTopCustomers(query),
        getCustomerSegments(query),
        getCategorySales(query),
        getProductSales({ ...query, order: 'best', limit: query.productLimit || 10 }),
        getProductSales({ ...query, order: 'least', limit: query.productLimit || 10 }),
        getPromisePerformance(query)
    ]);
    return { topCustomers, segments, categorySales, bestSelling, leastSelling, promise };
}
