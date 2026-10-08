import mongoose from 'mongoose';
import { FoodProductRequest } from '../models/productRequest.model.js';
import { FoodUser } from '../../../../core/users/user.model.js';
import { sendResponse, sendError } from '../../../../utils/response.js';

/**
 * Customer submits a request for a product we do not stock yet.
 * POST /food/user/product-requests
 */
export async function createProductRequestController(req, res, next) {
    try {
        const userId = req.user?.userId;
        if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
            return sendError(res, 401, 'Unauthorized or invalid user');
        }

        const body = req.body || {};
        const productName = String(body.productName || '').trim();
        if (!productName) return sendError(res, 400, 'productName is required');

        // Snapshot the customer's name/phone so the admin list reads without a join.
        const user = await FoodUser.findById(userId).select('name phone').lean();

        const created = await FoodProductRequest.create({
            userId: new mongoose.Types.ObjectId(userId),
            productName,
            brand: String(body.brand || '').trim(),
            category: String(body.category || '').trim(),
            quantity: String(body.quantity || '').trim(),
            note: String(body.note || body.description || '').trim(),
            customerName: user?.name || '',
            customerPhone: user?.phone || '',
        });

        return sendResponse(res, 201, 'Product request submitted', { request: created.toObject() });
    } catch (e) {
        next(e);
    }
}

/**
 * The customer's own request history.
 * GET /food/user/product-requests
 */
export async function listMyProductRequestsController(req, res, next) {
    try {
        const userId = req.user?.userId;
        if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
            return sendError(res, 401, 'Unauthorized or invalid user');
        }
        const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 20, 1), 50);
        const page = Math.max(parseInt(req.query?.page, 10) || 1, 1);
        const skip = (page - 1) * limit;

        const filter = { userId: new mongoose.Types.ObjectId(userId) };
        const [requests, total] = await Promise.all([
            FoodProductRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            FoodProductRequest.countDocuments(filter),
        ]);

        return sendResponse(res, 200, 'Product requests fetched', { requests, total, page, limit });
    } catch (e) {
        next(e);
    }
}
