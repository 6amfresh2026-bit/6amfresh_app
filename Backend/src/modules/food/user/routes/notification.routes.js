import express from 'express';
import {
    getInboxController,
    getUnreadCountController,
    markNotificationReadController,
    markAllNotificationsReadController,
    dismissNotificationController,
    dismissAllNotificationsController
} from '../../../../core/notifications/notification.controller.js';

/**
 * In-app notifications for the customer app.
 *
 * Mounted under /food/user/notifications, so every route is already the
 * signed-in user (USER role, enforced where userRoutes is mounted). The
 * handlers are the shared core controllers — they resolve the owner from the
 * token — so a user only ever sees and touches their own inbox.
 *
 *   GET    /                 the inbox (paginated) with its unread count
 *   GET    /unread-count     just the badge number
 *   PATCH  /read-all         mark every notification read (keeps them listed)
 *   DELETE /clear            clear the whole inbox
 *   PATCH  /:id/read         mark one read
 *   DELETE /:id              remove one
 */
const router = express.Router();

// Collection-level routes first, so "unread-count", "read-all" and "clear"
// are never mistaken for an :id.
router.get('/', getInboxController);
router.get('/unread-count', getUnreadCountController);
router.patch('/read-all', markAllNotificationsReadController);
router.delete('/clear', dismissAllNotificationsController);

router.patch('/:id/read', markNotificationReadController);
router.delete('/:id', dismissNotificationController);

export default router;
