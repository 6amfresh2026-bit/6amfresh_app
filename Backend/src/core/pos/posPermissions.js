import { sendError } from '../../utils/response.js';

/**
 * What an admin can allow a POS user to do at the till (Admin > POS users > Permissions).
 *
 * Grouped the way the admin form shows them. A POS user with no saved permissions can do all of it,
 * so accounts made before this existed keep working; the admin narrows from there.
 */
export const POS_PERMISSION_GROUPS = [
    {
        key: 'billing',
        label: 'Billing',
        permissions: [
            { key: 'sell', label: 'Create bills' },
            { key: 'discount', label: 'Give discounts' },
            { key: 'coupons', label: 'Apply coupons' },
            { key: 'pay_later', label: 'Sell on credit (pay later)' },
            { key: 'hold_bills', label: 'Hold & resume bills' }
        ]
    },
    {
        key: 'customers',
        label: 'Customers',
        permissions: [
            { key: 'customers', label: 'Add & edit customers' },
            { key: 'loyalty', label: 'Redeem loyalty points' }
        ]
    },
    {
        key: 'returns',
        label: 'Returns',
        permissions: [{ key: 'credit_notes', label: 'Issue & void credit notes' }]
    },
    {
        key: 'register',
        label: 'Register & cash',
        permissions: [
            { key: 'open_register', label: 'Open register' },
            { key: 'close_register', label: 'Close register' },
            { key: 'cash_movement', label: 'Cash in / out' }
        ]
    },
    {
        key: 'history',
        label: 'History',
        permissions: [{ key: 'view_bills', label: 'See bill history' }]
    }
];

export const POS_PERMISSIONS = POS_PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));

export const DEFAULT_LIMITS = { maxBillAmount: 0, maxDiscountPercent: 0 };

/** The permissions a user holds: everything when none were ever saved, else exactly the saved ones. */
export const resolvePermissions = (saved) =>
    Array.isArray(saved) ? POS_PERMISSIONS.filter((k) => saved.includes(k)) : [...POS_PERMISSIONS];

export const resolveLimits = (saved) => ({
    maxBillAmount: Math.max(0, Number(saved?.maxBillAmount) || 0),
    maxDiscountPercent: Math.min(100, Math.max(0, Number(saved?.maxDiscountPercent) || 0))
});

/**
 * Route guard. A cashier session must hold the permission; the store owner (no posUserId on the
 * session) is not a POS user and is never restricted here.
 */
export const requirePosPermission = (key) => (req, res, next) => {
    if (!req.user?.posUserId) return next();
    if ((req.user.posPermissions || []).includes(key)) return next();
    const label = POS_PERMISSION_GROUPS.flatMap((g) => g.permissions).find((p) => p.key === key)?.label || key;
    return sendError(res, 403, `Your POS account is not allowed to: ${label.toLowerCase()}`);
};
