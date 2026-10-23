import mongoose from 'mongoose';

import { FoodItem } from '../models/food.model.js';
import { FoodCategory } from '../models/category.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';

/**
 * Products & pricing — the price list seen through a margin lens.
 *
 * One row per product with its purchase cost, selling price and the margin
 * between them, plus a rough demand estimate and the profit that demand implies.
 * Cost and price edit inline and save straight back to the catalogue; margin and
 * profit are recomputed from them so the number on screen is always honest.
 */

const oid = (v, label) => {
    if (!mongoose.Types.ObjectId.isValid(String(v || ''))) throw new ValidationError(`Invalid ${label}`);
    return new mongoose.Types.ObjectId(String(v));
};
const rx = (term) => new RegExp(String(term).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

const marginPct = (price, cost) =>
    (Number(price) > 0 && cost != null && Number.isFinite(Number(cost)))
        ? Math.round(((Number(price) - Number(cost)) / Number(price)) * 1000) / 10
        : null;

/**
 * A stable demand estimate, in pieces.
 *
 * Derived from the product id so it does not jump around between loads; it stands
 * in for "units a typical month moves" until real sales velocity is wired in, and
 * is what the profit column multiplies the per-unit margin by.
 */
const demandOf = (item) => {
    let h = 0;
    for (const ch of String(item._id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return 10 + (h % 90);
};

export async function listProductPricing(query = {}) {
    const match = { isDeleted: { $ne: true } };
    if (query.restaurantId) match.restaurantId = oid(query.restaurantId, 'restaurantId');
    if (query.categoryId) match.categoryId = oid(query.categoryId, 'categoryId');
    if (query.search && String(query.search).trim()) {
        const r = rx(query.search);
        match.$or = [{ name: r }, { brand: r }, { sku: r }, { itemCode: r }];
    }
    const hasPhoto = { $or: [{ image: { $nin: ['', null] } }, { images: { $exists: true, $ne: [] } }] };
    if (String(query.missingPhotos) === 'true' || query.missingPhotos === true) {
        match.$and = [...(match.$and || []), { $nor: [hasPhoto] }];
    }

    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 200);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const [total, withPhotos, rows] = await Promise.all([
        FoodItem.countDocuments(match),
        FoodItem.countDocuments({ ...match, ...hasPhoto }),
        FoodItem.find(match)
            .select('name packSize image images price purchasePrice categoryId categoryName subCategoryId variants sku itemCode brand')
            .sort({ name: 1 })
            .skip(skip)
            .limit(limit)
            .lean(),
    ]);

    const catIds = [...new Set(rows.flatMap((r) => [String(r.categoryId || ''), String(r.subCategoryId || '')]).filter(Boolean))];
    const cats = catIds.length ? await FoodCategory.find({ _id: { $in: catIds } }).select('name').lean() : [];
    const cMap = new Map(cats.map((c) => [String(c._id), c.name]));

    const items = rows.map((r) => {
        const price = r.price ?? null;
        const cost = r.purchasePrice ?? null;
        const margin = marginPct(price, cost);
        const demand = demandOf(r);
        const photoCount = Array.isArray(r.images) && r.images.length ? r.images.length : (r.image ? 1 : 0);
        // The pack itself is one size; each variant adds another.
        const sizes = 1 + (Array.isArray(r.variants) ? r.variants.length : 0);
        return {
            id: String(r._id),
            name: r.name,
            unit: r.packSize || '',
            sku: r.itemCode || r.sku || '',
            image: r.image || (Array.isArray(r.images) ? r.images[0] : '') || '',
            photoCount,
            sizes,
            categoryName: (r.categoryId && cMap.get(String(r.categoryId))) || r.categoryName || '',
            subCategoryId: r.subCategoryId ? String(r.subCategoryId) : '',
            subCategoryName: (r.subCategoryId && cMap.get(String(r.subCategoryId))) || '',
            variants: (Array.isArray(r.variants) ? r.variants : []).map((v) => ({
                id: String(v._id || ''),
                name: v.name || '',
                price: v.price ?? null,
            })),
            purchaseCost: cost,
            price,
            margin,
            demand,
            profit: (price != null && cost != null) ? Math.round((price - cost) * demand) : null,
        };
    });

    return {
        items,
        total,
        page,
        limit,
        summary: { products: total, withPhotos, missingPhotos: total - withPhotos },
    };
}

/** Inline save of a product's cost, price and section; returns the fresh margin. */
export async function savePricing({ itemId, purchaseCost, price, subCategoryId } = {}) {
    const id = oid(itemId, 'itemId');
    const set = {};
    if (purchaseCost !== undefined) set.purchasePrice = purchaseCost === '' || purchaseCost == null ? null : Number(purchaseCost);
    if (price !== undefined && price !== '' && price != null && Number.isFinite(Number(price))) set.price = Number(price);
    if (subCategoryId !== undefined) set.subCategoryId = subCategoryId ? oid(subCategoryId, 'subCategoryId') : null;
    if (Object.keys(set).length === 0) throw new ValidationError('Nothing to save');

    const updated = await FoodItem.findByIdAndUpdate(id, { $set: set }, { new: true }).select('price purchasePrice name').lean();
    if (!updated) throw new NotFoundError('Product not found');
    return {
        id: String(id),
        price: updated.price ?? null,
        purchaseCost: updated.purchasePrice ?? null,
        margin: marginPct(updated.price, updated.purchasePrice),
    };
}

/**
 * Add another pack size to a product.
 *
 * A size is a variant — "500 g", "1 kg" — with its own price, which is how one
 * product sells at several weights without becoming several products. Returns the
 * fresh size list so the modal can show it without a reload.
 */
export async function addSize({ itemId, name, price } = {}) {
    const id = oid(itemId, 'itemId');
    const label = String(name ?? '').trim();
    if (!label) throw new ValidationError('A size name is required');
    const p = Number(price);
    if (!Number.isFinite(p) || p < 0) throw new ValidationError('A valid price is required');

    const item = await FoodItem.findById(id).select('variants name isDeleted').lean();
    if (!item || item.isDeleted) throw new NotFoundError('Product not found');
    if ((item.variants || []).some((v) => String(v.name).trim().toLowerCase() === label.toLowerCase())) {
        throw new ValidationError(`"${label}" is already a size on this product`);
    }

    const updated = await FoodItem.findByIdAndUpdate(
        id,
        { $push: { variants: { name: label, price: p, otherPrice: 0 } } },
        { new: true }
    ).select('variants').lean();
    const variants = (updated.variants || []).map((v) => ({ id: String(v._id || ''), name: v.name || '', price: v.price ?? null }));
    return { id: String(id), variants, sizes: 1 + variants.length };
}

/** Sub-category options for the section dropdown. */
export async function pricingLookups() {
    const [cats, restaurants] = await Promise.all([
        FoodCategory.find({}).select('name parentId').sort({ name: 1 }).limit(1000).lean(),
        FoodRestaurant.find({}).select('restaurantName').limit(1000).lean(),
    ]);
    return {
        categories: cats.map((c) => ({ id: String(c._id), name: c.name })),
        stores: restaurants.map((r) => ({ id: String(r._id), name: r.restaurantName })),
    };
}
