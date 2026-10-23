import mongoose from 'mongoose';

import { FoodItem } from '../models/food.model.js';
import { FoodCategory } from '../models/category.model.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * Barcodes & labels — one scannable code per product.
 *
 * A product either carries a manufacturer's barcode (scanned in and saved) or
 * gets an internal one. Internal codes are EAN-13 in the "29" prefix GS1 reserves
 * for in-store use, so they never clash with a real packaged product's code. The
 * check digit and the SVG drawing live in the frontend barcode util; the server's
 * job is only to hand out and store the digits, and to keep them unique.
 *
 * `barcode` empty means "no saved code": the screen still shows an auto one so a
 * label can be printed, but it is not persisted until the admin presses Generate
 * & save, which is what the "works, but not saved yet" count means.
 */

const oid = (v, label) => {
    if (!mongoose.Types.ObjectId.isValid(String(v || ''))) throw new ValidationError(`Invalid ${label}`);
    return new mongoose.Types.ObjectId(String(v));
};
const rx = (term) => new RegExp(String(term).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

const eanCheck = (first12) => {
    let sum = 0;
    for (let i = 0; i < 12; i += 1) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (sum % 10)) % 10;
};
const isValidEan13 = (v) => /^\d{13}$/.test(String(v || '')) && eanCheck(String(v).slice(0, 12)) === Number(String(v)[12]);

/** An internal EAN-13 for a sequence number: 29 + 10 digits + check digit. */
const autoEan = (seq) => {
    const body = '29' + String(Math.abs(Number(seq) || 0) % 1e10).padStart(10, '0');
    return body + eanCheck(body);
};

/**
 * A stable sequence for a product's auto code.
 *
 * The number in its item code or SKU where there is one — so SF-0003 reads as a
 * tidy "…0003" on the shelf label — and otherwise a hash of its id, which is
 * stable per product and effectively collision-free in the 10-digit space.
 */
const seqOf = (item) => {
    const m = String(item.itemCode || item.sku || '').match(/(\d+)/);
    if (m) return Number(m[1]);
    let h = 0;
    for (const ch of String(item._id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % 1e9;
};

const displayCodeOf = (item) => (item.barcode && String(item.barcode).trim()) || autoEan(seqOf(item));

// ───────────────────────────── List ─────────────────────────────

export async function listBarcodes(query = {}) {
    const match = { isDeleted: { $ne: true } };
    if (query.restaurantId) match.restaurantId = oid(query.restaurantId, 'restaurantId');
    if (query.categoryId) match.categoryId = oid(query.categoryId, 'categoryId');
    if (query.search && String(query.search).trim()) {
        const r = rx(query.search);
        match.$or = [{ name: r }, { sku: r }, { itemCode: r }, { barcode: r }];
    }
    // `missing` narrows to products that still have no saved code.
    if (String(query.filter) === 'missing') match.$and = [...(match.$and || []), { $or: [{ barcode: '' }, { barcode: null }, { barcode: { $exists: false } }] }];
    if (String(query.filter) === 'saved') match.barcode = { $nin: ['', null] };

    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 200);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    // The tiles summarise the whole filtered set, not just this page — a count
    // that only added up one page would read wrong on every page but the last.
    const savedMatch = { ...match, barcode: { $nin: ['', null] } };
    const [total, ownSaved, soldByWeight, dupAgg, rows] = await Promise.all([
        FoodItem.countDocuments(match),
        FoodItem.countDocuments(savedMatch),
        FoodItem.countDocuments({ ...match, soldByWeight: true }),
        // Auto codes are unique by sequence, so a real duplicate can only be two
        // saved codes that match — count the products caught in such a clash.
        FoodItem.aggregate([
            { $match: savedMatch },
            { $group: { _id: '$barcode', n: { $sum: 1 } } },
            { $match: { n: { $gt: 1 } } },
            { $group: { _id: null, total: { $sum: '$n' } } },
        ]),
        FoodItem.find(match)
            .select('name packSize sku itemCode barcode price mrp expiryDate categoryId categoryName soldByWeight unitId restaurantId')
            .sort({ itemCode: 1, name: 1 })
            .skip(skip)
            .limit(limit)
            .lean(),
    ]);

    const catIds = [...new Set(rows.map((r) => String(r.categoryId || '')).filter(Boolean))];
    const cats = catIds.length ? await FoodCategory.find({ _id: { $in: catIds } }).select('name').lean() : [];
    const cMap = new Map(cats.map((c) => [String(c._id), c.name]));

    const items = rows.map((r) => {
        const saved = Boolean(r.barcode && String(r.barcode).trim());
        const code = displayCodeOf(r);
        return {
            id: String(r._id),
            name: r.name,
            unit: r.packSize || '',
            sku: r.itemCode || r.sku || '',
            barcode: code,
            saved,
            format: isValidEan13(code) ? 'EAN-13' : 'Code 128',
            source: saved ? 'saved' : 'auto',
            extraCodes: [],
            price: r.price ?? null,
            mrp: r.mrp ?? null,
            // Printed on the label when the cashier ticks "Expiry date".
            expiryDate: r.expiryDate || null,
            restaurantId: r.restaurantId ? String(r.restaurantId) : null,
            categoryName: (r.categoryId && cMap.get(String(r.categoryId))) || r.categoryName || '',
            soldByWeight: r.soldByWeight === true,
        };
    });

    return {
        items,
        total,
        page,
        limit,
        summary: {
            products: total,
            soldByWeight,
            ownSaved,
            autoCode: total - ownSaved,
            duplicates: dupAgg[0]?.total || 0,
        },
    };
}

// ───────────────────────── Generate & save ─────────────────────────

/**
 * Persist internal codes for products that do not have one.
 *
 * Only empty ones are touched, so a saved manufacturer code is never overwritten.
 * Each assigned code is checked against the codes already in the catalogue and
 * the ones handed out in this run, and nudged forward on the rare clash, so two
 * products can never end up sharing a barcode.
 */
export async function saveBarcodes({ itemIds = [], restaurantId } = {}) {
    const match = { isDeleted: { $ne: true }, $or: [{ barcode: '' }, { barcode: null }, { barcode: { $exists: false } }] };
    if (Array.isArray(itemIds) && itemIds.length) match._id = { $in: itemIds.map((v) => oid(v, 'itemId')) };
    if (restaurantId) match.restaurantId = oid(restaurantId, 'restaurantId');

    const targets = await FoodItem.find(match).select('sku itemCode _id').lean();
    if (targets.length === 0) return { saved: 0 };

    // Everything already in use, so a new code cannot collide with a saved one.
    const used = new Set(
        (await FoodItem.find({ barcode: { $nin: ['', null] } }).select('barcode').lean()).map((r) => String(r.barcode))
    );

    const ops = [];
    for (const t of targets) {
        let seq = seqOf(t);
        let code = autoEan(seq);
        let guard = 0;
        while (used.has(code) && guard < 1000) { seq += 1; code = autoEan(seq); guard += 1; }
        used.add(code);
        ops.push({ updateOne: { filter: { _id: t._id }, update: { $set: { barcode: code } } } });
    }
    const res = await FoodItem.bulkWrite(ops, { ordered: false });
    return { saved: res.modifiedCount || ops.length };
}

// ───────────────────────── Edit one ─────────────────────────

/** Save (or clear) a single product's barcode — a scanned manufacturer code, say. */
export async function updateBarcode({ itemId, barcode } = {}) {
    const id = oid(itemId, 'itemId');
    const code = String(barcode ?? '').trim();
    if (code) {
        if (!/^[\x20-\x7e]+$/.test(code)) throw new ValidationError('Barcode has unprintable characters');
        const clash = await FoodItem.findOne({ _id: { $ne: id }, barcode: code, isDeleted: { $ne: true } }).select('_id name').lean();
        if (clash) throw new ValidationError(`That code is already on "${clash.name}"`);
    }
    const updated = await FoodItem.findByIdAndUpdate(id, { $set: { barcode: code } }, { new: true }).select('barcode name').lean();
    if (!updated) throw new ValidationError('Product not found');
    return { id: String(id), barcode: updated.barcode || '' };
}
