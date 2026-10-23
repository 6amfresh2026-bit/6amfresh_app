import mongoose from 'mongoose';

import { FoodItem } from '../models/food.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * "Weighed items & rates" — loose produce sold by weight at the store counters.
 *
 * A weighed item is a FoodItem flagged `soldByWeight`, priced per kilogram. The
 * same product (e.g. Tomato) exists as one FoodItem per store, so this screen
 * groups those copies by name into a single row: one shared set of rates on the
 * left, a per-store stock chip on the right. Publishing a rate writes it to
 * every store's copy at once, which is why the counter staff see it go live
 * everywhere the moment it is published.
 *
 * Stock itself is not touched here — the per-store "Stock" button reuses the
 * ordinary stock-adjust endpoint, so weighed stock flows through the same ledger
 * as everything else.
 */

const oid = (v, label) => {
    if (!mongoose.Types.ObjectId.isValid(String(v || ''))) throw new ValidationError(`Invalid ${label}`);
    return new mongoose.Types.ObjectId(String(v));
};
const rxExact = (name) => new RegExp(`^${String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
const rxLike = (term) => new RegExp(String(term).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const marginPct = (rate, cost) =>
    (Number(rate) > 0 && cost != null && Number.isFinite(Number(cost)))
        ? Math.round(((Number(rate) - Number(cost)) / Number(rate)) * 100)
        : null;

// Below this many kg in a store, a weighed item is "running low" on the counter.
const LOW_KG = 5;

// ───────────────────────────── List ─────────────────────────────

export async function listWeighed(query = {}) {
    const match = { soldByWeight: true, isDeleted: { $ne: true } };
    if (query.search && String(query.search).trim()) match.name = rxLike(query.search);
    // A store filter narrows the rows to groups that have a copy in that store,
    // without hiding the other stores' chips — the rates are shared, so the row
    // is still the same product everywhere.
    const storeId = query.restaurantId && mongoose.Types.ObjectId.isValid(String(query.restaurantId))
        ? new mongoose.Types.ObjectId(String(query.restaurantId))
        : null;

    const groups = await FoodItem.aggregate([
        { $match: match },
        { $sort: { name: 1 } },
        {
            $group: {
                _id: { $toLower: { $trim: { input: '$name' } } },
                name: { $first: '$name' },
                categoryName: { $first: { $ifNull: ['$categoryName', ''] } },
                foodType: { $first: '$foodType' },
                rate: { $max: '$price' },
                smallQtyRate: { $max: '$smallQtyRate' },
                cost: { $max: '$purchasePrice' },
                updatedAt: { $max: '$updatedAt' },
                restaurantIds: { $addToSet: '$restaurantId' },
                members: {
                    $push: {
                        id: '$_id',
                        restaurantId: '$restaurantId',
                        stockQty: '$stockQty',
                        isAvailable: '$isAvailable'
                    }
                }
            }
        },
        storeId ? { $match: { restaurantIds: storeId } } : { $match: {} },
        { $sort: { name: 1 } }
    ]);

    const restIds = [...new Set(groups.flatMap((g) => g.members.map((m) => String(m.restaurantId))).filter(Boolean))];
    const restaurants = restIds.length
        ? await FoodRestaurant.find({ _id: { $in: restIds } }).select('restaurantName').lean()
        : [];
    const rMap = new Map(restaurants.map((r) => [String(r._id), r.restaurantName]));

    let lowStock = 0;
    const storesShowing = new Set();
    const items = groups.map((g) => {
        const stores = g.members
            .map((m) => {
                const on = m.isAvailable !== false;
                const stockKg = m.stockQty == null ? 0 : Number(m.stockQty);
                if (on) storesShowing.add(String(m.restaurantId));
                if (on && stockKg < LOW_KG) lowStock += 1;
                return {
                    itemId: String(m.id),
                    restaurantId: String(m.restaurantId),
                    restaurantName: rMap.get(String(m.restaurantId)) || 'Store',
                    stockKg,
                    tracked: m.stockQty != null,
                    on
                };
            })
            .sort((a, b) => a.restaurantName.localeCompare(b.restaurantName));
        return {
            key: g._id,
            name: g.name,
            categoryName: g.categoryName || '',
            foodType: g.foodType || '',
            rate: g.rate ?? null,
            smallQtyRate: g.smallQtyRate ?? null,
            cost: g.cost ?? null,
            margin: marginPct(g.rate, g.cost),
            updatedAt: g.updatedAt || null,
            stores
        };
    });

    const margins = items.map((i) => i.margin).filter((m) => m != null);
    const avgMargin = margins.length ? Math.round(margins.reduce((a, b) => a + b, 0) / margins.length) : 0;

    return {
        items,
        summary: {
            looseItems: items.length,
            avgMargin,
            lowStock,
            under500: items.filter((i) => i.smallQtyRate != null).length,
            storesShowing: storesShowing.size
        }
    };
}

// ───────────────────────────── Publish rates ─────────────────────────────

/**
 * Apply the typed-in rates to every store copy of each named item at once.
 *
 * Only the fields actually supplied are written, so publishing a row where the
 * admin only touched the 1 kg rate does not blank out a cost they left alone.
 */
export async function publishRates({ rates = [], restaurantId } = {}) {
    if (!Array.isArray(rates) || rates.length === 0) throw new ValidationError('No rates to publish');
    const storeFilter = restaurantId && mongoose.Types.ObjectId.isValid(String(restaurantId))
        ? { restaurantId: new mongoose.Types.ObjectId(String(restaurantId)) }
        : {};

    const ops = [];
    for (const r of rates) {
        const name = String(r?.name || '').trim();
        if (!name) continue;
        const set = {};
        if (r.rate != null && r.rate !== '' && Number.isFinite(Number(r.rate))) set.price = Number(r.rate);
        if (r.smallQtyRate === null || r.smallQtyRate === '') set.smallQtyRate = null;
        else if (r.smallQtyRate != null && Number.isFinite(Number(r.smallQtyRate))) set.smallQtyRate = Number(r.smallQtyRate);
        if (r.cost === null || r.cost === '') set.purchasePrice = null;
        else if (r.cost != null && Number.isFinite(Number(r.cost))) set.purchasePrice = Number(r.cost);
        if (Object.keys(set).length === 0) continue;
        ops.push({
            updateMany: {
                filter: { soldByWeight: true, isDeleted: { $ne: true }, name: rxExact(name), ...storeFilter },
                update: { $set: set }
            }
        });
    }
    if (ops.length === 0) throw new ValidationError('Nothing to update');
    const res = await FoodItem.bulkWrite(ops, { ordered: false });
    return { groups: ops.length, updated: res.modifiedCount || 0 };
}

// ───────────────────────────── Add item ─────────────────────────────

/**
 * Add a weighed item across one or more stores.
 *
 * A store that already stocks a product of this name gets that product flagged
 * `soldByWeight` with the new rates, rather than a duplicate created beside it;
 * a store that does not gets a fresh weighed item. Either way every store ends
 * up with exactly one copy, which is what keeps the grouped row honest.
 */
export async function addWeighedItem({ name, categoryName = '', foodType = 'Veg', rate, smallQtyRate = null, cost = null, restaurantIds = [] } = {}) {
    const clean = String(name || '').trim();
    if (!clean) throw new ValidationError('Name is required');
    if (rate == null || !Number.isFinite(Number(rate)) || Number(rate) < 0) throw new ValidationError('A 1 kg rate is required');

    let stores = Array.isArray(restaurantIds) ? restaurantIds.map((v) => oid(v, 'restaurantId')) : [];
    if (stores.length === 0) {
        const all = await FoodRestaurant.find({}).select('_id').lean();
        stores = all.map((r) => r._id);
    }
    if (stores.length === 0) throw new ValidationError('No stores to add the item to');

    const small = (smallQtyRate === '' || smallQtyRate == null) ? null : Number(smallQtyRate);
    const purchase = (cost === '' || cost == null) ? null : Number(cost);

    let created = 0;
    let updated = 0;
    for (const restaurantId of stores) {
        const existing = await FoodItem.findOne({ restaurantId, name: rxExact(clean), isDeleted: { $ne: true } }).select('_id').lean();
        if (existing) {
            await FoodItem.updateOne(
                { _id: existing._id },
                { $set: { soldByWeight: true, price: Number(rate), smallQtyRate: small, purchasePrice: purchase, ...(categoryName ? { categoryName } : {}) } }
            );
            updated += 1;
        } else {
            await FoodItem.create({
                restaurantId,
                name: clean,
                categoryName,
                foodType: foodType === 'Non-Veg' ? 'Non-Veg' : 'Veg',
                price: Number(rate),
                purchasePrice: purchase,
                smallQtyRate: small,
                soldByWeight: true,
                stockQty: null,
                isAvailable: true,
                approvalStatus: 'approved'
            });
            created += 1;
        }
    }
    return { created, updated };
}
