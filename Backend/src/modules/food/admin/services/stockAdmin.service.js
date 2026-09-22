import mongoose from 'mongoose';

import { FoodItem } from '../models/food.model.js';
import { FoodBrand } from '../models/brand.model.js';
import { FoodUnit } from '../models/unit.model.js';
import { FoodDepartment } from '../models/department.model.js';
import { FoodCategory } from '../models/category.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { FoodStockMovement } from '../../orders/models/stockMovement.model.js';
import { FoodStockVerification } from '../../orders/models/stockVerification.model.js';
import { recordMovement } from '../../orders/services/stockLedger.service.js';
import { nextSequence } from '../models/counter.model.js';
import { NotFoundError, ValidationError } from '../../../../core/auth/errors.js';
import { stockTier, DEFAULT_STOCK_THRESHOLDS } from '../../shared/stockTiers.js';

/**
 * Admin stock screens: the Stocks list (what is on the shelf, with manual
 * adjustment and per-item history) and Stock Verification (a physical count
 * applied against the book figure).
 *
 * Every write to stockQty here goes through a single conditional
 * findOneAndUpdate and then the ledger — the same discipline as the order path
 * in inventory.service.js, so a count and a sale racing each other cannot both
 * win.
 */

const MAX_LIMIT = 500;
const parsePaging = (q = {}) => {
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 10, 1), MAX_LIMIT);
    const page = Math.max(parseInt(q.page, 10) || 1, 1);
    return { page, limit, skip: (page - 1) * limit };
};
const oid = (v, label) => {
    if (!mongoose.Types.ObjectId.isValid(String(v || ''))) throw new ValidationError(`Invalid ${label}`);
    return new mongoose.Types.ObjectId(String(v));
};
const rx = (term) => new RegExp(String(term).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const actorOf = (user) => ({ role: user?.role || 'ADMIN', id: user?.userId ? oid(user.userId, 'user') : null, name: user?.name || '' });

/**
 * untracked / out / critical / low / in_stock.
 *
 * Delegates to the shared tier logic so this screen cannot drift from the
 * storefront card and the alerting, which is what happens the moment the
 * comparison is written out twice.
 */
const stockStatus = (f, outlet = null) => stockTier(f, outlet);

// ───────────────────────────── Stocks list ─────────────────────────────

export async function listStocks(query = {}) {
    const { page, limit, skip } = parsePaging(query);
    const match = { isDeleted: { $ne: true } };
    if (query.restaurantId) match.restaurantId = oid(query.restaurantId, 'restaurantId');
    if (query.departmentId) match.departmentId = oid(query.departmentId, 'departmentId');
    if (query.categoryId) match.categoryId = oid(query.categoryId, 'categoryId');
    if (query.brandId) match.brandId = oid(query.brandId, 'brandId');
    if (query.unitId) match.unitId = oid(query.unitId, 'unitId');
    if (query.search && String(query.search).trim()) {
        const r = rx(query.search);
        match.$or = [{ name: r }, { itemCode: r }, { brand: r }, { categoryName: r }];
    }

    // Status needs a field-to-field compare (stockQty <= lowStockThreshold), which
    // a plain find cannot express, hence the pipeline.
    const statusExpr = {
        $switch: {
            branches: [
                { case: { $eq: ['$stockQty', null] }, then: 'untracked' },
                // Platform defaults only: the outlet's own thresholds cannot be
                // reached here without a $lookup per row. This exists so the
                // status *filter* can run in the database; the served rows are
                // re-classified below with the outlet in hand, so what the
                // screen displays is always the outlet-aware answer.
                { case: { $lte: ['$stockQty', { $ifNull: ['$outOfStockThreshold', DEFAULT_STOCK_THRESHOLDS.out] }] }, then: 'out' },
                { case: { $lte: ['$stockQty', { $ifNull: ['$criticalStockThreshold', DEFAULT_STOCK_THRESHOLDS.critical] }] }, then: 'critical' },
                { case: { $lte: ['$stockQty', { $ifNull: ['$lowStockThreshold', DEFAULT_STOCK_THRESHOLDS.low] }] }, then: 'low' },
            ],
            default: 'in_stock'
        }
    };
    const pipeline = [{ $match: match }, { $addFields: { stockStatus: statusExpr } }];
    if (query.status && ['in_stock', 'low', 'critical', 'out', 'untracked'].includes(query.status)) {
        pipeline.push({ $match: { stockStatus: query.status } });
    }

    // The footer totals are for the whole filtered set, not just this page — the
    // reference shows one Total row under a paginated table, and a total that
    // only added up ten rows would be wrong on every page but the last.
    const [rows, countRes, totalsRes] = await Promise.all([
        FoodItem.aggregate([...pipeline, { $sort: { name: 1 } }, { $skip: skip }, { $limit: limit }]),
        FoodItem.aggregate([...pipeline, { $count: 'n' }]),
        FoodItem.aggregate([
            ...pipeline,
            { $group: { _id: null, totalAvailableQty: { $sum: { $ifNull: ['$stockQty', 0] } }, testingQty: { $sum: { $ifNull: ['$testingQty', 0] } } } }
        ])
    ]);
    const total = countRes[0]?.n || 0;

    const ids = (k) => [...new Set(rows.map((r) => String(r[k] || '')).filter(Boolean))];
    const categoryIds = [...new Set([...ids('categoryId'), ...ids('subCategoryId')])];
    const brandIds = [...new Set([...ids('brandId'), ...ids('subBrandId')])];
    const [restaurants, departments, categories, brands, units, lastMoves] = await Promise.all([
        ids('restaurantId').length ? FoodRestaurant.find({ _id: { $in: ids('restaurantId') } }).select('restaurantName stockThresholds').lean() : [],
        ids('departmentId').length ? FoodDepartment.find({ _id: { $in: ids('departmentId') } }).select('name').lean() : [],
        categoryIds.length ? FoodCategory.find({ _id: { $in: categoryIds } }).select('name').lean() : [],
        brandIds.length ? FoodBrand.find({ _id: { $in: brandIds } }).select('name').lean() : [],
        ids('unitId').length ? FoodUnit.find({ _id: { $in: ids('unitId') } }).select('name shortName').lean() : [],
        rows.length
            ? FoodStockMovement.aggregate([
                { $match: { itemId: { $in: rows.map((r) => r._id) } } },
                { $sort: { createdAt: -1 } },
                { $group: { _id: '$itemId', at: { $first: '$createdAt' }, type: { $first: '$type' } } }
            ])
            : []
    ]);
    const rMap = new Map(restaurants.map((r) => [String(r._id), r.restaurantName]));
    // The outlet itself, so a row is classified against the thresholds its
    // shop configured rather than the platform defaults.
    const outletMap = new Map(restaurants.map((r) => [String(r._id), r]));
    const dMap = new Map(departments.map((d) => [String(d._id), d.name]));
    const cMap = new Map(categories.map((c) => [String(c._id), c.name]));
    const bMap = new Map(brands.map((b) => [String(b._id), b.name]));
    const uMap = new Map(units.map((u) => [String(u._id), u]));
    const mMap = new Map(lastMoves.map((m) => [String(m._id), m]));

    return {
        stocks: rows.map((f) => ({
            id: String(f._id),
            itemCode: f.itemCode || '',
            name: f.name,
            image: f.image || '',
            restaurantId: String(f.restaurantId || ''),
            restaurantName: rMap.get(String(f.restaurantId)) || '',
            departmentName: (f.departmentId && dMap.get(String(f.departmentId))) || '',
            // The item snapshots categoryName, so a product saved before the
            // structured link existed still shows something in the column.
            categoryName: (f.categoryId && cMap.get(String(f.categoryId))) || f.categoryName || '',
            subCategoryName: (f.subCategoryId && cMap.get(String(f.subCategoryId))) || '',
            brandName: (f.brandId && bMap.get(String(f.brandId))) || f.brand || '',
            subBrandName: (f.subBrandId && bMap.get(String(f.subBrandId))) || '',
            unitName: (f.unitId && uMap.get(String(f.unitId))?.name) || f.packSize || '',
            unitShortName: (f.unitId && uMap.get(String(f.unitId))?.shortName) || '',
            totalAvailableQty: f.stockQty ?? 0,
            testingQty: f.testingQty ?? 0,
            stockQty: f.stockQty ?? null,
            lowStockThreshold: f.lowStockThreshold ?? null,
            status: stockStatus(f, outletMap.get(String(f.restaurantId)) || null),
            isAvailable: f.isAvailable !== false,
            lastMovementAt: mMap.get(String(f._id))?.at || null,
            lastMovementType: mMap.get(String(f._id))?.type || ''
        })),
        totals: {
            totalAvailableQty: totalsRes[0]?.totalAvailableQty || 0,
            testingQty: totalsRes[0]?.testingQty || 0
        },
        total,
        page,
        limit
    };
}

/**
 * Manual +/- from the Stocks screen.
 *
 * mode 'add' and 'remove' are relative and refuse an untracked item (there is
 * nothing to add to); 'set' is absolute and is also how an untracked item
 * becomes tracked — the first `set` is written to the ledger as `opening`.
 */
export async function adjustStock({ itemId, mode, qty, reason = '', note = '' }, user) {
    const id = oid(itemId, 'itemId');
    const n = Number(qty);
    if (!['add', 'remove', 'set'].includes(mode)) throw new ValidationError('mode must be add, remove or set');
    if (!Number.isFinite(n) || n < 0) throw new ValidationError('qty must be 0 or more');
    if (mode !== 'set' && n === 0) throw new ValidationError('qty must be greater than 0');

    const before = await FoodItem.findById(id).select('stockQty name itemCode restaurantId isDeleted').lean();
    if (!before || before.isDeleted) throw new NotFoundError('Product not found');
    const wasUntracked = before.stockQty === null || before.stockQty === undefined;
    if (wasUntracked && mode !== 'set') {
        throw new ValidationError('This product is untracked. Use "Set" to give it an opening quantity first.');
    }

    let filter = { _id: id };
    let update;
    if (mode === 'add') { filter.stockQty = { $ne: null }; update = { $inc: { stockQty: n } }; }
    else if (mode === 'remove') { filter.stockQty = { $gte: n }; update = { $inc: { stockQty: -n } }; }
    else { update = { $set: { stockQty: n } }; }

    const updated = await FoodItem.findOneAndUpdate(filter, update, { new: true, projection: { stockQty: 1, name: 1, itemCode: 1, restaurantId: 1 } }).lean();
    if (!updated) {
        throw new ValidationError(`Only ${before.stockQty} in stock — cannot remove ${n}`);
    }

    // Keep the availability flag in step, the same way the order path does.
    await FoodItem.updateOne({ _id: id, stockQty: 0 }, { $set: { isAvailable: false } });
    await FoodItem.updateOne({ _id: id, stockQty: { $gt: 0 }, isAvailable: false, stockOffMode: { $in: [null, undefined] } }, { $set: { isAvailable: true } });

    const qtyBefore = wasUntracked ? null : Number(before.stockQty);
    const qtyAfter = Number(updated.stockQty);
    await recordMovement({
        itemId: id,
        item: updated,
        type: wasUntracked ? 'opening' : 'adjustment',
        qtyChange: qtyBefore === null ? qtyAfter : qtyAfter - qtyBefore,
        qtyBefore,
        qtyAfter,
        reason: String(reason || '').trim() || (mode === 'set' ? 'Stock set' : mode === 'add' ? 'Stock added' : 'Stock removed'),
        note: String(note || '').trim(),
        reference: { kind: 'manual', id: null, label: '' },
        createdBy: actorOf(user)
    });

    return { id: String(id), stockQty: qtyAfter, qtyBefore, status: stockStatus(updated) };
}

export async function listMovements(query = {}) {
    const { page, limit, skip } = parsePaging(query);
    const filter = {};
    if (query.itemId) filter.itemId = oid(query.itemId, 'itemId');
    if (query.restaurantId) filter.restaurantId = oid(query.restaurantId, 'restaurantId');
    if (query.type) filter.type = String(query.type);
    if (query.from || query.to) {
        filter.createdAt = {};
        if (query.from) filter.createdAt.$gte = new Date(query.from);
        if (query.to) { const t = new Date(query.to); t.setHours(23, 59, 59, 999); filter.createdAt.$lte = t; }
    }
    if (query.search && String(query.search).trim()) {
        const r = rx(query.search);
        filter.$or = [{ itemName: r }, { itemCode: r }, { reason: r }, { 'reference.label': r }];
    }
    const [rows, total] = await Promise.all([
        FoodStockMovement.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        FoodStockMovement.countDocuments(filter)
    ]);
    return {
        movements: rows.map((m) => ({
            id: String(m._id),
            itemId: String(m.itemId),
            itemName: m.itemName,
            itemCode: m.itemCode,
            type: m.type,
            qtyChange: m.qtyChange,
            qtyBefore: m.qtyBefore,
            qtyAfter: m.qtyAfter,
            reason: m.reason || '',
            note: m.note || '',
            reference: m.reference || null,
            createdBy: m.createdBy || null,
            createdAt: m.createdAt
        })),
        total,
        page,
        limit
    };
}

// ───────────────────────── Stock verification ─────────────────────────

const serializeVerification = (v, restaurantName = '') => {
    const lines = (v.items || []).map((l) => ({
        id: String(l._id),
        itemId: String(l.itemId),
        itemCode: l.itemCode || '',
        itemName: l.itemName || '',
        unitShortName: l.unitShortName || '',
        bookQty: l.bookQty ?? null,
        countedQty: l.countedQty ?? null,
        difference: l.countedQty === null || l.countedQty === undefined ? null : Number(l.countedQty) - Number(l.bookQty || 0),
        note: l.note || ''
    }));
    const counted = lines.filter((l) => l.countedQty !== null);
    return {
        id: String(v._id),
        verificationNo: v.verificationNo,
        restaurantId: String(v.restaurantId),
        restaurantName,
        status: v.status,
        note: v.note || '',
        items: lines,
        itemCount: lines.length,
        countedCount: counted.length,
        totalDifference: counted.reduce((s, l) => s + (l.difference || 0), 0),
        createdAt: v.createdAt,
        completedAt: v.completedAt,
        cancelledAt: v.cancelledAt
    };
};

const buildLines = async (restaurantId, itemIds) => {
    const filter = { restaurantId, isDeleted: { $ne: true } };
    if (Array.isArray(itemIds) && itemIds.length) filter._id = { $in: itemIds.map((i) => oid(i, 'itemId')) };
    else filter.stockQty = { $ne: null }; // "all tracked products of this store"
    const items = await FoodItem.find(filter).select('name itemCode stockQty unitId packSize').sort({ name: 1 }).lean();
    const unitIds = [...new Set(items.map((i) => String(i.unitId || '')).filter(Boolean))];
    const units = unitIds.length ? await FoodUnit.find({ _id: { $in: unitIds } }).select('shortName').lean() : [];
    const uMap = new Map(units.map((u) => [String(u._id), u.shortName]));
    return items.map((i) => ({
        itemId: i._id,
        itemCode: i.itemCode || '',
        itemName: i.name,
        unitShortName: (i.unitId && uMap.get(String(i.unitId))) || i.packSize || '',
        bookQty: i.stockQty ?? null,
        countedQty: null,
        note: ''
    }));
};

export async function listVerifications(query = {}) {
    const { page, limit, skip } = parsePaging(query);
    const filter = {};
    if (query.restaurantId) filter.restaurantId = oid(query.restaurantId, 'restaurantId');
    if (query.status && ['draft', 'completed', 'cancelled'].includes(query.status)) filter.status = query.status;
    if (query.search && String(query.search).trim()) filter.verificationNo = rx(query.search);
    const [rows, total] = await Promise.all([
        FoodStockVerification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        FoodStockVerification.countDocuments(filter)
    ]);
    const rIds = [...new Set(rows.map((r) => String(r.restaurantId)))];
    const restaurants = rIds.length ? await FoodRestaurant.find({ _id: { $in: rIds } }).select('restaurantName').lean() : [];
    const rMap = new Map(restaurants.map((r) => [String(r._id), r.restaurantName]));
    return { verifications: rows.map((v) => serializeVerification(v, rMap.get(String(v.restaurantId)) || '')), total, page, limit };
}

export async function createVerification({ restaurantId, itemIds, note = '' }, user) {
    const rid = oid(restaurantId, 'restaurantId');
    const restaurant = await FoodRestaurant.findById(rid).select('restaurantName').lean();
    if (!restaurant) throw new NotFoundError('Store not found');
    const items = await buildLines(rid, itemIds);
    if (!items.length) throw new ValidationError('No tracked products found for this store. Set opening stock first.');
    const seq = await nextSequence('stock_verification_no');
    const doc = await FoodStockVerification.create({
        verificationNo: `STV${String(seq).padStart(7, '0')}`,
        restaurantId: rid,
        items,
        note: String(note || '').trim(),
        createdBy: user?.userId ? oid(user.userId, 'user') : null
    });
    return serializeVerification(doc.toObject(), restaurant.restaurantName);
}

export async function getVerification(id) {
    const v = await FoodStockVerification.findById(oid(id, 'id')).lean();
    if (!v) throw new NotFoundError('Verification not found');
    const r = await FoodRestaurant.findById(v.restaurantId).select('restaurantName').lean();
    return serializeVerification(v, r?.restaurantName || '');
}

/** Draft only: counted quantities, notes, lines added or removed. */
export async function updateVerification(id, body = {}) {
    const v = await FoodStockVerification.findById(oid(id, 'id'));
    if (!v) throw new NotFoundError('Verification not found');
    if (v.status !== 'draft') throw new ValidationError(`A ${v.status} verification cannot be edited`);

    if (body.note !== undefined) v.note = String(body.note || '').trim();

    if (Array.isArray(body.items)) {
        for (const line of body.items) {
            const existing = v.items.id(line.id) || v.items.find((l) => String(l.itemId) === String(line.itemId));
            if (!existing) continue;
            if (line.countedQty !== undefined) {
                if (line.countedQty === null || line.countedQty === '') existing.countedQty = null;
                else {
                    const n = Number(line.countedQty);
                    if (!Number.isFinite(n) || n < 0) throw new ValidationError(`Counted qty for ${existing.itemName} must be 0 or more`);
                    existing.countedQty = n;
                }
            }
            if (line.note !== undefined) existing.note = String(line.note || '').trim();
        }
    }
    if (Array.isArray(body.addItemIds) && body.addItemIds.length) {
        const have = new Set(v.items.map((l) => String(l.itemId)));
        const fresh = (await buildLines(v.restaurantId, body.addItemIds)).filter((l) => !have.has(String(l.itemId)));
        v.items.push(...fresh);
    }
    if (Array.isArray(body.removeLineIds) && body.removeLineIds.length) {
        const drop = new Set(body.removeLineIds.map(String));
        v.items = v.items.filter((l) => !drop.has(String(l._id)));
    }

    await v.save();
    const r = await FoodRestaurant.findById(v.restaurantId).select('restaurantName').lean();
    return serializeVerification(v.toObject(), r?.restaurantName || '');
}

/**
 * Applies the count. Each counted line sets stockQty to the counted figure and
 * writes a `verification` movement for the difference. Lines never counted are
 * left alone — an uncounted shelf is unknown, not zero.
 */
export async function completeVerification(id, user) {
    const v = await FoodStockVerification.findById(oid(id, 'id'));
    if (!v) throw new NotFoundError('Verification not found');
    if (v.status !== 'draft') throw new ValidationError(`Verification is already ${v.status}`);
    const counted = v.items.filter((l) => l.countedQty !== null && l.countedQty !== undefined);
    if (!counted.length) throw new ValidationError('Enter a counted quantity for at least one product');

    const actor = actorOf(user);
    const applied = [];
    for (const line of counted) {
        const updated = await FoodItem.findOneAndUpdate(
            { _id: line.itemId, isDeleted: { $ne: true } },
            { $set: { stockQty: Number(line.countedQty) } },
            { new: true, projection: { stockQty: 1, name: 1, itemCode: 1, restaurantId: 1 } }
        ).lean();
        if (!updated) continue;
        await FoodItem.updateOne({ _id: line.itemId, stockQty: 0 }, { $set: { isAvailable: false } });
        await FoodItem.updateOne({ _id: line.itemId, stockQty: { $gt: 0 }, isAvailable: false, stockOffMode: { $in: [null, undefined] } }, { $set: { isAvailable: true } });
        const before = line.bookQty ?? null;
        const diff = Number(line.countedQty) - Number(before || 0);
        await recordMovement({
            itemId: line.itemId,
            item: updated,
            type: 'verification',
            qtyChange: diff,
            qtyBefore: before,
            qtyAfter: Number(line.countedQty),
            reason: diff === 0 ? 'Physical count matched' : diff > 0 ? 'Physical count found excess' : 'Physical count found shortage',
            note: line.note || '',
            reference: { kind: 'verification', id: v._id, label: v.verificationNo },
            createdBy: actor
        });
        applied.push({ itemId: String(line.itemId), difference: diff });
    }

    v.status = 'completed';
    v.completedAt = new Date();
    v.completedBy = actor.id;
    await v.save();
    const r = await FoodRestaurant.findById(v.restaurantId).select('restaurantName').lean();
    return { ...serializeVerification(v.toObject(), r?.restaurantName || ''), applied };
}

export async function cancelVerification(id) {
    const v = await FoodStockVerification.findById(oid(id, 'id'));
    if (!v) throw new NotFoundError('Verification not found');
    if (v.status !== 'draft') throw new ValidationError(`Verification is already ${v.status}`);
    v.status = 'cancelled';
    v.cancelledAt = new Date();
    await v.save();
    return { id: String(v._id), status: v.status };
}

export async function deleteVerification(id) {
    const v = await FoodStockVerification.findById(oid(id, 'id')).select('status').lean();
    if (!v) throw new NotFoundError('Verification not found');
    if (v.status === 'completed') throw new ValidationError('A completed verification is part of the stock history and cannot be deleted');
    await FoodStockVerification.deleteOne({ _id: v._id });
    return { id: String(v._id) };
}
