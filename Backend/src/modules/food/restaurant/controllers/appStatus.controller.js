import { sendResponse } from '../../../../utils/response.js';
import { getStoreAppStatus, recordPosHeartbeat } from '../services/appStatus.service.js';

/** POST /pos/heartbeat - the till checks in (seller session). */
export const posHeartbeatController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'POS online', await recordPosHeartbeat(req.user?.userId));
    } catch (error) {
        next(error);
    }
};

/** GET /restaurants/:id/app-status - public, never cached. */
export const getStoreAppStatusController = async (req, res, next) => {
    try {
        res.set('Cache-Control', 'no-store');
        return sendResponse(res, 200, 'Store status', await getStoreAppStatus(req.params.id));
    } catch (error) {
        next(error);
    }
};
