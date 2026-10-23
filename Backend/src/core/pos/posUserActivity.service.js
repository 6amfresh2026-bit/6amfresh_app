import mongoose from 'mongoose';
import { FoodPosUser } from './posUser.model.js';
import { FoodOrder } from '../../modules/food/orders/models/order.model.js';
import { FoodPosShift } from '../../modules/food/restaurant/models/posShift.model.js';
import { FoodRestaurant } from '../../modules/food/restaurant/models/restaurant.model.js';
import { FoodLoginAudit } from '../auth/loginAudit.model.js';
import { ValidationError } from '../auth/errors.js';

/**
 * Everything a POS user did at the till, for Admin > POS users.
 *
 * It reads what the till already records, now stamped with the cashier (see actorFields in
 * pos.service.js): bills from the orders, registers and cash in/out from the shifts, and sign-ins
 * from the login audit. Bills and registers made before this existed, or by the store owner, carry
 * no cashier and are not counted here.
 */

const CANCELLED = ['cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin'];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const dayStart = (d = new Date()) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};

/** from/to (inclusive days) from a query, defaulting to the last 30 days. */
export const resolveRange = ({ from, to } = {}) => {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 29 * 86400000);
    if (Number.isNaN(end.getTime()) || Number.isNaN(start.getTime())) throw new ValidationError('Invalid date range');
    const a = dayStart(start);
    const b = dayStart(end);
    b.setDate(b.getDate() + 1);
    if (b <= a) throw new ValidationError('The end date must be after the start date');
    return { start: a, end: b };
};

const oid = (id) => new mongoose.Types.ObjectId(String(id));

/** Bills, sales and tender mix for some POS users over a range, keyed by user id. */
const billStats = async (userIds, start, end) => {
    const ids = userIds.map(oid);
    const [totals, tenders] = await Promise.all([
        FoodOrder.aggregate([
            { $match: { source: 'pos', 'pos.posUserId': { $in: ids }, createdAt: { $gte: start, $lt: end } } },
            {
                $group: {
                    _id: '$pos.posUserId',
                    bills: { $sum: { $cond: [{ $in: ['$orderStatus', CANCELLED] }, 0, 1] } },
                    cancelled: { $sum: { $cond: [{ $in: ['$orderStatus', CANCELLED] }, 1, 0] } },
                    sales: { $sum: { $cond: [{ $in: ['$orderStatus', CANCELLED] }, 0, '$pricing.total'] } },
                    due: { $sum: { $cond: [{ $in: ['$orderStatus', CANCELLED] }, 0, '$pos.dueAmount'] } },
                    lastBillAt: { $max: '$createdAt' }
                }
            }
        ]),
        FoodOrder.aggregate([
            {
                $match: {
                    source: 'pos',
                    'pos.posUserId': { $in: ids },
                    createdAt: { $gte: start, $lt: end },
                    orderStatus: { $nin: CANCELLED }
                }
            },
            { $unwind: '$pos.tenders' },
            { $group: { _id: { u: '$pos.posUserId', m: '$pos.tenders.mode' }, amount: { $sum: '$pos.tenders.amount' } } }
        ])
    ]);

    const out = new Map();
    for (const t of totals) {
        out.set(String(t._id), {
            bills: t.bills,
            cancelled: t.cancelled,
            sales: round2(t.sales),
            due: round2(t.due),
            avgBill: t.bills ? round2(t.sales / t.bills) : 0,
            lastBillAt: t.lastBillAt,
            byMode: {}
        });
    }
    for (const t of tenders) {
        const row = out.get(String(t._id.u));
        if (row) row.byMode[t._id.m || 'other'] = round2(t.amount);
    }
    return out;
};

const emptyStats = () => ({ bills: 0, cancelled: 0, sales: 0, due: 0, avgBill: 0, lastBillAt: null, byMode: {} });

/**
 * One line per user for the list: today's bills and sales, whether a register is open under them,
 * and when they were last seen doing anything (last bill, register event or sign-in).
 */
export const enrichPosUsers = async (users) => {
    if (!users.length) return users;
    const ids = users.map((u) => u.id);
    const today = dayStart();
    const tomorrow = new Date(today.getTime() + 86400000);

    const [stats, openShifts, lastShift, lastLogin] = await Promise.all([
        billStats(ids, today, tomorrow),
        FoodPosShift.find({ openedByPosUserId: { $in: ids.map(oid) }, status: 'open' })
            .select('openedByPosUserId openedAt shiftCode')
            .lean(),
        FoodPosShift.aggregate([
            { $match: { openedByPosUserId: { $in: ids.map(oid) } } },
            { $group: { _id: '$openedByPosUserId', at: { $max: '$updatedAt' } } }
        ]),
        FoodLoginAudit.aggregate([
            { $match: { role: 'POS', userId: { $in: ids.map(oid) } } },
            { $group: { _id: '$userId', at: { $max: '$loginAt' } } }
        ])
    ]);
    // The last bill ever, not just today's, so "last active" does not read empty every morning.
    const lastBills = await FoodOrder.aggregate([
        { $match: { source: 'pos', 'pos.posUserId': { $in: ids.map(oid) } } },
        { $group: { _id: '$pos.posUserId', at: { $max: '$createdAt' } } }
    ]);

    const open = new Map(openShifts.map((s) => [String(s.openedByPosUserId), s]));
    const latest = new Map();
    for (const list of [lastShift, lastLogin, lastBills]) {
        for (const r of list) {
            const k = String(r._id);
            if (r.at && (!latest.get(k) || r.at > latest.get(k))) latest.set(k, r.at);
        }
    }

    return users.map((u) => {
        const s = stats.get(u.id) || emptyStats();
        const shift = open.get(u.id);
        return {
            ...u,
            today: { bills: s.bills, sales: s.sales },
            registerOpen: Boolean(shift),
            registerOpenedAt: shift?.openedAt || null,
            lastActiveAt: latest.get(u.id) || u.lastLoginAt || null
        };
    });
};

/** The full picture for one POS user over a date range. */
export const getPosUserActivity = async (id, query = {}) => {
    if (!mongoose.isValidObjectId(id)) throw new ValidationError('POS user is invalid');
    const user = await FoodPosUser.findById(id).select('-password').lean();
    if (!user) throw new ValidationError('POS user not found');
    const { start, end } = resolveRange(query);
    const uid = oid(id);

    const [stats, bills, shifts, logins, store] = await Promise.all([
        billStats([id], start, end),
        FoodOrder.find({ source: 'pos', 'pos.posUserId': uid, createdAt: { $gte: start, $lt: end } })
            .sort({ createdAt: -1 })
            .limit(50)
            .select('order_id orderStatus pricing.total pos.paymentMode pos.dueAmount pos.billNo customerName createdAt')
            .lean(),
        FoodPosShift.find({
            $or: [{ openedByPosUserId: uid }, { closedByPosUserId: uid }, { 'movements.posUserId': uid }],
            openedAt: { $gte: start, $lt: end }
        })
            .sort({ openedAt: -1 })
            .limit(50)
            .lean(),
        FoodLoginAudit.find({ role: 'POS', userId: uid }).sort({ loginAt: -1 }).limit(15).lean(),
        FoodRestaurant.findById(user.restaurantId).select('restaurantName name').lean()
    ]);

    const movements = [];
    for (const s of shifts) {
        for (const m of s.movements || []) {
            if (String(m.posUserId) === String(id)) {
                movements.push({ type: m.type, amount: m.amount, at: m.at, shiftCode: s.shiftCode });
            }
        }
    }
    movements.sort((a, b) => new Date(b.at) - new Date(a.at));

    return {
        user: {
            id: String(user._id),
            name: user.name,
            username: user.username,
            phone: user.phone || '',
            isActive: user.isActive !== false,
            restaurantId: String(user.restaurantId),
            restaurantName: store?.restaurantName || store?.name || '',
            lastLoginAt: user.lastLoginAt || null,
            createdAt: user.createdAt
        },
        range: { from: start, to: new Date(end.getTime() - 1) },
        stats: stats.get(String(id)) || emptyStats(),
        bills: bills.map((b) => ({
            id: String(b._id),
            billNo: b.pos?.billNo || b.order_id,
            status: b.orderStatus,
            total: round2(b.pricing?.total),
            paymentMode: b.pos?.paymentMode || '',
            due: round2(b.pos?.dueAmount),
            customerName: b.customerName || '',
            at: b.createdAt
        })),
        shifts: shifts.map((s) => ({
            id: String(s._id),
            code: s.shiftCode,
            status: s.status,
            role: [
                String(s.openedByPosUserId) === String(id) ? 'opened' : null,
                String(s.closedByPosUserId) === String(id) ? 'closed' : null
            ].filter(Boolean),
            openedAt: s.openedAt,
            closedAt: s.closedAt,
            openingCash: s.openingCash,
            cashSales: s.cashSales,
            billsCount: s.billsCount,
            expectedCash: s.expectedCash,
            countedCash: s.countedCash,
            difference: s.difference,
            closeReason: s.closeReason || ''
        })),
        movements,
        logins: logins.map((l) => ({ at: l.loginAt, system: l.systemDetails || '', ip: l.ipAddress || '' }))
    };
};
