import { sendResponse } from '../../../../utils/response.js';
import { POS_PERMISSION_GROUPS } from '../../../../core/pos/posPermissions.js';
import { getPosUserActivity } from '../../../../core/pos/posUserActivity.service.js';
import {
    createPosUser,
    deletePosUser,
    listPosUsers,
    resetPosUserPassword,
    updatePosUser,
} from '../../../../core/pos/posUser.service.js';

/** GET /pos-users - the POS users, optionally for one store. */
export const listPosUsersController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'POS users', await listPosUsers(req.query || {}));
    } catch (error) {
        next(error);
    }
};

/** GET /pos-users/permissions - what can be allowed, grouped for the form. */
export const posPermissionsController = (req, res) =>
    sendResponse(res, 200, 'POS permissions', { groups: POS_PERMISSION_GROUPS });

/** GET /pos-users/:id/activity - bills, registers, cash movements and sign-ins of one POS user. */
export const posUserActivityController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'POS user activity', await getPosUserActivity(req.params.id, req.query || {}));
    } catch (error) {
        next(error);
    }
};

/** POST /pos-users - create a till login for a store. */
export const createPosUserController = async (req, res, next) => {
    try {
        const user = await createPosUser(req.body || {}, req.user?.userId);
        return sendResponse(res, 201, 'POS user created', { user });
    } catch (error) {
        next(error);
    }
};

/** PATCH /pos-users/:id - name, phone, or active on/off. */
export const updatePosUserController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'POS user updated', { user: await updatePosUser(req.params.id, req.body || {}) });
    } catch (error) {
        next(error);
    }
};

/** POST /pos-users/:id/password - set a new password. */
export const resetPosUserPasswordController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Password updated', await resetPosUserPassword(req.params.id, req.body?.password));
    } catch (error) {
        next(error);
    }
};

/** DELETE /pos-users/:id */
export const deletePosUserController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'POS user deleted', await deletePosUser(req.params.id));
    } catch (error) {
        next(error);
    }
};
