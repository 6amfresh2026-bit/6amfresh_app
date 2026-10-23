import { sendResponse } from '../../../../utils/response.js';
import { listAppTimings, saveAppTimings } from '../services/appTimings.service.js';
import { recordPosHeartbeat } from '../../restaurant/services/appStatus.service.js';

/** GET /app-timings - every approved store with its settings and live status. */
export const listAppTimingsController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'App timings', await listAppTimings(req.query || {}));
    } catch (error) {
        next(error);
    }
};

/** PATCH /app-timings/:restaurantId - save one store's settings. */
export const saveAppTimingsController = async (req, res, next) => {
    try {
        const store = await saveAppTimings(req.params.restaurantId, req.body || {}, req.user?.userId);
        return sendResponse(res, 200, 'Timings saved', { store });
    } catch (error) {
        next(error);
    }
};

/** POST /pos/heartbeat - the admin's copy of the till, running a store's POS, checks in for that store. */
export const adminPosHeartbeatController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'POS online', await recordPosHeartbeat(req.body?.restaurantId));
    } catch (error) {
        next(error);
    }
};
