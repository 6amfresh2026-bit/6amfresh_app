import mongoose from 'mongoose';
import { FoodItem } from '../models/food.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { recordMovement } from '../../orders/services/stockLedger.service.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * Bulk import — add products, update prices, and load opening stock from a
 * spreadsheet. The app parses the CSV and sends rows as JSON; this module
 * matches each row to an existing product (barcode, then SKU, then name + size)
 * and either updates it or creates a new one. "Check" is a dry run that writes
 * nothing; "Commit" applies the changes and records a stock movement for every
 * quantity it sets.
 */

const str = (v) => String(v ?? '').trim();
const num = (v) => {
    const raw = String(v ?? '').trim();
    if (raw === '') return null;
    const n = Number(raw.replace(/[₹,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
};
const exact = (s) => new RegExp(`^${String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

/** Map a header-keyed CSV row onto the fields the importer understands. */
function normalizeRow(raw = {}) {
    const pick = (...names) => {
        for (const want of names) {
            for (const key of Object.keys(raw)) {
                if (key.trim().toLowerCase() === want) return raw[key];
            }
        }
        return '';
    };
    return {
        name: str(pick('name', 'item name', 'product')),
        size: str(pick('size', 'pack size', 'packsize')),
        category: str(pick('category')),
        subcategory: str(pick('subcategory', 'sub category')),
        brand: str(pick('brand')),
        sku: str(pick('sku', 'item code', 'itemcode')),
        barcode: str(pick('barcode')),
        mrp: num(pick('mrp')),
        price: num(pick('price', 'selling price')),
        cost: num(pick('cost', 'purchase cost', 'purchase price')),
        gst: num(pick('gst', 'gst rate')),
        supplier: str(pick('supplier')),
        store: str(pick('store')),
        stock: num(pick('stock', 'qty', 'quantity')),
        minStock: num(pick('min_stock', 'min stock', 'minstock'))
    };
}

async function buildStoreMap() {
    const stores = await FoodRestaurant.find({}).select('restaurantName').lean();
    return {
        byName: new Map(stores.map((s) => [str(s.restaurantName).toLowerCase(), String(s._id)])),
        byId: new Map(stores.map((s) => [String(s._id), s.restaurantName]))
    };
}

/** Find the existing product a row refers to: barcode, then SKU, then name (+ size). */
async function matchItem(restaurantId, row) {
    const rid = new mongoose.Types.ObjectId(String(restaurantId));
    if (row.barcode) {
        const m = await FoodItem.findOne({ restaurantId: rid, barcode: row.barcode });
        if (m) return { item: m, by: 'barcode' };
    }
    if (row.sku) {
        const m = await FoodItem.findOne({ restaurantId: rid, $or: [{ sku: row.sku }, { itemCode: row.sku }] });
        if (m) return { item: m, by: 'sku' };
    }
    if (row.name) {
        const q = { restaurantId: rid, name: exact(row.name) };
        if (row.size) q.packSize = exact(row.size);
        const m = await FoodItem.findOne(q);
        if (m) return { item: m, by: 'name' };
    }
    return { item: null, by: null };
}

const resolveStore = (row, byName, byId, defaultStore) =>
    row.store ? (byName.get(row.store.toLowerCase()) || null) : (defaultStore && byId.has(defaultStore) ? defaultStore : null);

/** Dry run — classify every row as create / update / error, writing nothing. */
export async function bulkImportCheck({ rows = [], storeId = '' } = {}) {
    if (!Array.isArray(rows) || !rows.length) throw new ValidationError('No rows to check');
    const { byName, byId } = await buildStoreMap();
    const defaultStore = storeId && byId.has(String(storeId)) ? String(storeId) : '';
    const out = [];
    let creates = 0, updates = 0, errors = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = normalizeRow(rows[i]);
        const line = i + 1;
        if (!row.name) { out.push({ line, name: '', action: 'error', message: 'Missing product name' }); errors++; continue; }
        const rid = resolveStore(row, byName, byId, defaultStore);
        if (!rid) { out.push({ line, name: row.name, action: 'error', message: row.store ? `Unknown store "${row.store}"` : 'No store selected for this row' }); errors++; continue; }

        const { item, by } = await matchItem(rid, row);
        if (item) {
            const changes = [];
            if (row.price != null && row.price !== item.price) changes.push('price');
            if (row.cost != null && row.cost !== item.purchasePrice) changes.push('cost');
            if (row.mrp != null && row.mrp !== item.mrp) changes.push('mrp');
            if (row.minStock != null && row.minStock !== item.lowStockThreshold) changes.push('min stock');
            if (row.stock != null && row.stock !== item.stockQty) changes.push('stock');
            out.push({ line, name: row.name, store: byId.get(rid), action: 'update', matchedBy: by, changes });
            updates++;
        } else if (row.price == null) {
            out.push({ line, name: row.name, store: byId.get(rid), action: 'error', message: 'New product needs a price' });
            errors++;
        } else {
            out.push({ line, name: row.name, store: byId.get(rid), action: 'create' });
            creates++;
        }
    }
    return { rows: out, summary: { total: rows.length, creates, updates, errors } };
}

/** Apply the import — create new products, update prices, set stock on hand. */
export async function bulkImportCommit({ rows = [], storeId = '' } = {}, user = {}) {
    if (!Array.isArray(rows) || !rows.length) throw new ValidationError('No rows to import');
    const { byName, byId } = await buildStoreMap();
    const defaultStore = storeId && byId.has(String(storeId)) ? String(storeId) : '';
    const actor = { role: 'ADMIN', id: user?.userId || null, name: user?.name || 'Admin' };
    let created = 0, updated = 0, stockMoved = 0, errors = 0;
    const errorRows = [];

    const setStock = async (itemId, before, next) => {
        if (next == null || next === before) return;
        const updatedItem = await FoodItem.findOneAndUpdate(
            { _id: itemId }, { $set: { stockQty: next } },
            { new: true, projection: { stockQty: 1, name: 1, itemCode: 1, restaurantId: 1, lowStockThreshold: 1, criticalStockThreshold: 1, outOfStockThreshold: 1, stockAlert: 1 } }
        ).lean();
        await FoodItem.updateOne({ _id: itemId, stockQty: 0 }, { $set: { isAvailable: false } });
        await FoodItem.updateOne({ _id: itemId, stockQty: { $gt: 0 }, isAvailable: false, stockOffMode: { $in: [null, undefined] } }, { $set: { isAvailable: true } });
        await recordMovement({
            itemId, item: updatedItem,
            type: before == null ? 'opening' : 'adjustment',
            qtyChange: before == null ? next : next - before,
            qtyBefore: before ?? null, qtyAfter: next,
            reason: 'Bulk import', createdBy: actor
        });
        stockMoved++;
    };

    for (let i = 0; i < rows.length; i++) {
        const row = normalizeRow(rows[i]);
        const line = i + 1;
        try {
            if (!row.name) throw new Error('Missing product name');
            const rid = resolveStore(row, byName, byId, defaultStore);
            if (!rid) throw new Error(row.store ? `Unknown store "${row.store}"` : 'No store for this row');
            const { item } = await matchItem(rid, row);

            if (item) {
                const set = {};
                if (row.price != null) set.price = row.price;
                if (row.cost != null) set.purchasePrice = row.cost;
                if (row.mrp != null) set.mrp = row.mrp;
                if (row.gst != null) set.gstRate = row.gst;
                if (row.minStock != null) set.lowStockThreshold = row.minStock;
                if (row.size) set.packSize = row.size;
                if (row.brand) set.brand = row.brand;
                if (row.category) set.categoryName = row.category;
                if (row.barcode && !item.barcode) set.barcode = row.barcode;
                if (row.sku && !item.sku) set.sku = row.sku;
                if (Object.keys(set).length) await FoodItem.updateOne({ _id: item._id }, { $set: set });
                await setStock(item._id, item.stockQty, row.stock);
                updated++;
            } else {
                if (row.price == null) throw new Error('New product needs a price');
                const doc = {
                    restaurantId: new mongoose.Types.ObjectId(String(rid)),
                    name: row.name, price: row.price,
                    approvalStatus: 'approved', isAvailable: row.stock !== 0
                };
                if (row.size) doc.packSize = row.size;
                if (row.category) doc.categoryName = row.category;
                if (row.brand) doc.brand = row.brand;
                if (row.sku) doc.sku = row.sku;
                if (row.barcode) doc.barcode = row.barcode;
                if (row.mrp != null) doc.mrp = row.mrp;
                if (row.cost != null) doc.purchasePrice = row.cost;
                if (row.gst != null) doc.gstRate = row.gst;
                if (row.minStock != null) doc.lowStockThreshold = row.minStock;
                if (row.stock != null) doc.stockQty = row.stock;
                const createdItem = await FoodItem.create(doc);
                if (row.stock != null) {
                    await recordMovement({
                        itemId: createdItem._id, item: createdItem,
                        type: 'opening', qtyChange: row.stock, qtyBefore: null, qtyAfter: row.stock,
                        reason: 'Bulk import (new product)', createdBy: actor
                    });
                    stockMoved++;
                }
                created++;
            }
        } catch (e) {
            errors++;
            errorRows.push({ line, name: row.name, message: e.message });
        }
    }
    return { summary: { total: rows.length, created, updated, stockMoved, errors }, errors: errorRows };
}
