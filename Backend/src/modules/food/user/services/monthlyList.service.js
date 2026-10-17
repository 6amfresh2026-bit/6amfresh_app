import mongoose from 'mongoose';
import { FoodMonthlyList } from '../models/monthlyList.model.js';
import { FoodItem } from '../../admin/models/food.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { FoodUser } from '../../../../core/users/user.model.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { createOrder } from '../../orders/services/order.service.js';

const toObjectId = (value, label = 'Id') => {
    if (!value || !mongoose.Types.ObjectId.isValid(String(value))) {
        throw new ValidationError(`Invalid ${label}`);
    }
    return new mongoose.Types.ObjectId(String(value));
};

/** Validates items belong to the given restaurant and snapshots their current name. */
async function resolveListItems(restaurantId, rawItems = []) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
        throw new ValidationError('At least one item is required');
    }

    const itemIds = rawItems
        .map((item) => String(item?.itemId || '').trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (itemIds.length !== rawItems.length) {
        throw new ValidationError('One or more items have an invalid itemId');
    }

    const foodDocs = await FoodItem.find({
        _id: { $in: itemIds },
        restaurantId,
    })
        .select('name')
        .lean();
    const foodById = new Map(foodDocs.map((doc) => [String(doc._id), doc]));

    return rawItems.map((item) => {
        const doc = foodById.get(String(item.itemId));
        if (!doc) {
            throw new ValidationError(`Item ${item.itemId} does not belong to this restaurant`);
        }
        const quantity = Number(item.quantity);
        if (!Number.isFinite(quantity) || quantity < 1) {
            throw new ValidationError('Item quantity must be at least 1');
        }
        return {
            itemId: doc._id,
            variantId: String(item.variantId || '').trim(),
            quantity: Math.floor(quantity),
            name: doc.name || '',
        };
    });
}

export async function createMonthlyList(userId, dto) {
    const restaurantId = toObjectId(dto.restaurantId, 'restaurantId');
    const restaurant = await FoodRestaurant.findById(restaurantId).select('_id').lean();
    if (!restaurant) throw new NotFoundError('Restaurant not found');

    const items = await resolveListItems(restaurantId, dto.items);

    const doc = await FoodMonthlyList.create({
        userId,
        name: dto.name || 'My Monthly List',
        restaurantId,
        items,
    });
    return { list: doc.toObject() };
}

/**
 * Attaches the current image / price / MRP / pack-size to each list item so the
 * customer app renders real product thumbnails and prices. Items only store an
 * itemId + name snapshot; everything else is re-read fresh from FoodItem.
 */
async function attachItemDetailsToLists(lists) {
    const many = Array.isArray(lists);
    const arr = many ? lists : [lists];
    const itemIds = [
        ...new Set(
            arr.flatMap((l) => (l.items || []).map((i) => String(i.itemId))).filter(Boolean),
        ),
    ];
    if (!itemIds.length) return lists;

    const items = await FoodItem.find({ _id: { $in: itemIds } })
        .select('name image images price mrp otherPrice packSize variants')
        .lean();
    const byId = new Map(items.map((i) => [String(i._id), i]));

    const enrichItem = (item) => {
        const it = byId.get(String(item.itemId));
        if (!it) return item;
        let price = typeof it.price === 'number' ? it.price : 0;
        const mrp = typeof it.mrp === 'number' ? it.mrp : 0;
        if (item.variantId && Array.isArray(it.variants)) {
            const v = it.variants.find((variant) => String(variant._id) === String(item.variantId));
            if (v && typeof v.price === 'number') price = v.price;
        }
        return {
            ...item,
            image: it.image || (Array.isArray(it.images) && it.images.length ? it.images[0] : ''),
            price,
            mrp,
            packSize: it.packSize || '',
        };
    };

    const enrichList = (l) => ({ ...l, items: (l.items || []).map(enrichItem) });
    return many ? arr.map(enrichList) : enrichList(lists);
}

export async function listMonthlyLists(userId) {
    const lists = await FoodMonthlyList.find({ userId }).sort({ createdAt: -1 }).lean();
    return { lists: await attachItemDetailsToLists(lists) };
}

export async function getMonthlyList(userId, listId) {
    const id = toObjectId(listId, 'listId');
    const list = await FoodMonthlyList.findOne({ _id: id, userId }).lean();
    if (!list) throw new NotFoundError('Monthly list not found');
    return { list: await attachItemDetailsToLists(list) };
}

export async function updateMonthlyList(userId, listId, dto) {
    const id = toObjectId(listId, 'listId');
    const list = await FoodMonthlyList.findOne({ _id: id, userId });
    if (!list) throw new NotFoundError('Monthly list not found');

    if (dto.name !== undefined) list.name = dto.name;
    if (dto.isActive !== undefined) list.isActive = dto.isActive;
    if (dto.items !== undefined) {
        list.items = await resolveListItems(list.restaurantId, dto.items);
    }

    await list.save();
    return { list: list.toObject() };
}

export async function deleteMonthlyList(userId, listId) {
    const id = toObjectId(listId, 'listId');
    const result = await FoodMonthlyList.deleteOne({ _id: id, userId });
    if (result.deletedCount === 0) throw new NotFoundError('Monthly list not found');
    return { success: true };
}

/**
 * Places "this month's order" from a saved monthly list. Items are re-priced
 * and re-validated fresh through the normal order-creation path (stock,
 * availability, coupons, delivery fee, etc.) — the list only remembers what
 * to order, never a stale price.
 */
export async function placeMonthlyListOrder(userId, listId, dto = {}) {
    const id = toObjectId(listId, 'listId');
    const list = await FoodMonthlyList.findOne({ _id: id, userId }).lean();
    if (!list) throw new NotFoundError('Monthly list not found');
    if (!list.isActive) throw new ValidationError('This monthly list is inactive');
    if (!list.items?.length) throw new ValidationError('This monthly list has no items');

    let address = dto.address;
    if (!address && dto.addressId) {
        const user = await FoodUser.findById(userId).select('addresses').lean();
        const saved = (user?.addresses || []).find((a) => String(a._id) === String(dto.addressId));
        if (!saved) throw new ValidationError('Saved address not found');
        address = saved;
    }
    if (!address) throw new ValidationError('address or addressId is required');

    const orderDto = {
        restaurantId: String(list.restaurantId),
        items: list.items.map((item) => ({
            itemId: String(item.itemId),
            variantId: item.variantId || undefined,
            quantity: item.quantity,
        })),
        address,
        paymentMethod: dto.paymentMethod || 'cash',
        deliveryMode: dto.deliveryMode || 'basic',
        pricing: dto.couponCode ? { couponCode: dto.couponCode } : undefined,
    };

    const result = await createOrder(userId, orderDto);

    await FoodMonthlyList.updateOne(
        { _id: id },
        { $set: { lastOrderedAt: new Date(), lastOrderId: result?.order?._id || null } },
    );

    return result;
}
