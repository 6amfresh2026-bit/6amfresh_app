import express from 'express';
import { upload } from '../../../../middleware/upload.js';
import {
    listAddressesController,
    addAddressController,
    updateAddressController,
    deleteAddressController,
    setDefaultAddressController
} from '../controllers/userAddress.controller.js';
import {
    createMonthlyListController,
    listMonthlyListsController,
    getMonthlyListController,
    updateMonthlyListController,
    deleteMonthlyListController,
    placeMonthlyListOrderController
} from '../controllers/monthlyList.controller.js';
import {
    createSubscriptionController,
    listSubscriptionsController,
    getSubscriptionController,
    updateSubscriptionController,
    deleteSubscriptionController,
    listOccurrencesController,
    cancelOccurrenceController
} from '../controllers/productSubscription.controller.js';
import {
    getActiveSurveyController,
    submitSurveyResponseController
} from '../controllers/survey.controller.js';
import {
    getCurrentUserProfileController,
    updateCurrentUserProfileController,
    uploadCurrentUserProfileImageController,
    deleteCurrentUserAccountController
} from '../controllers/userProfile.controller.js';
import {
    getUserWalletController,
    createWalletTopupOrderController,
    verifyWalletTopupPaymentController
} from '../controllers/userWallet.controller.js';
import {
    getUserReferralDetailsController,
    getUserReferralStatsController
} from '../controllers/userReferral.controller.js';
import {
    createSafetyEmergencyReportController,
    listMySafetyEmergencyReportsController
} from '../controllers/userSafetyEmergency.controller.js';
import {
    createSupportTicketController,
    listMySupportTicketsController
} from '../controllers/supportTicket.controller.js';
import {
    createProductRequestController,
    listMyProductRequestsController
} from '../controllers/productRequest.controller.js';
import { syncUserCartController } from '../controllers/userCart.controller.js';
import {
    getFavoritesController,
    addFavoriteRestaurantController,
    removeFavoriteRestaurantController,
    addFavoriteFoodController,
    removeFavoriteFoodController
} from '../controllers/userFavorite.controller.js';
import {
    getCashbackHistoryController,
    getRefundHistoryController
} from '../controllers/cashback.controller.js';

const router = express.Router();

router.get('/profile', getCurrentUserProfileController);
router.patch('/profile', updateCurrentUserProfileController);
router.post('/profile/profile-image', upload.single('file'), uploadCurrentUserProfileImageController);
router.delete('/profile', deleteCurrentUserAccountController);

// Wallet (Bearer USER)
router.get('/wallet', getUserWalletController);
router.post('/wallet/topup/order', createWalletTopupOrderController);
router.post('/wallet/topup/verify', verifyWalletTopupPaymentController);

// Wallet sub-ledgers (both derived from the wallet/order records, no separate store)
router.get('/cashback', getCashbackHistoryController);
router.get('/refunds', getRefundHistoryController);

// Referral stats (Bearer USER)
router.get('/referrals/stats', getUserReferralStatsController);
router.get('/referrals/details', getUserReferralDetailsController);

// Safety / Emergency reports (Bearer USER)
router.post('/safety-emergency-reports', createSafetyEmergencyReportController);
router.get('/safety-emergency-reports', listMySafetyEmergencyReportsController);

// Support tickets (Bearer USER)
router.post('/support/ticket', createSupportTicketController);
router.get('/support/my-tickets', listMySupportTicketsController);

// Request a new product (not yet in the catalog) — visible to admins.
router.post('/product-requests', createProductRequestController);
router.get('/product-requests', listMyProductRequestsController);

router.get('/addresses', listAddressesController);
router.post('/addresses', addAddressController);
router.patch('/addresses/:addressId', updateAddressController);
router.delete('/addresses/:addressId', deleteAddressController);
router.patch('/addresses/:addressId/default', setDefaultAddressController);

router.get('/monthly-lists', listMonthlyListsController);
router.post('/monthly-lists', createMonthlyListController);
router.get('/monthly-lists/:listId', getMonthlyListController);
router.patch('/monthly-lists/:listId', updateMonthlyListController);
router.delete('/monthly-lists/:listId', deleteMonthlyListController);
router.post('/monthly-lists/:listId/order', placeMonthlyListOrderController);

router.get('/subscriptions', listSubscriptionsController);
router.post('/subscriptions', createSubscriptionController);
router.get('/subscriptions/:subscriptionId', getSubscriptionController);
router.patch('/subscriptions/:subscriptionId', updateSubscriptionController);
router.delete('/subscriptions/:subscriptionId', deleteSubscriptionController);
router.get('/subscriptions/:subscriptionId/occurrences', listOccurrencesController);
router.post('/subscriptions/:subscriptionId/occurrences/:occurrenceId/cancel', cancelOccurrenceController);

router.get('/survey/active', getActiveSurveyController);
router.post('/survey/:surveyId/respond', submitSurveyResponseController);

// Favourites. Auth + USER role are applied where this router is mounted.
router.get('/favorites', getFavoritesController);
router.post('/favorites/restaurants/:restaurantId', addFavoriteRestaurantController);
router.delete('/favorites/restaurants/:restaurantId', removeFavoriteRestaurantController);
router.post('/favorites/foods/:foodId', addFavoriteFoodController);
router.delete('/favorites/foods/:foodId', removeFavoriteFoodController);

router.put('/cart', syncUserCartController);

export default router;
