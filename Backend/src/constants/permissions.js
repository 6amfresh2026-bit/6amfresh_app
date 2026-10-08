export const ADMIN_ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];

export const ADMIN_PERMISSION_SECTIONS = [
    'dashboard',
    'point_of_sale',
    'food_management',
    'restaurant_management',
    'order_management',
    'promotions_management',
    'referral_rewards',
    'customer_management',
    'delivery_management',
    'support_management',
    'report_management',
    'transaction_management',
    'banner_management',
    'pages_social_media',
    'product_request_management'
];

export const ADMIN_FULL_PERMISSIONS = Object.freeze(
    Object.fromEntries(
        ADMIN_PERMISSION_SECTIONS.map((section) => [section, [...ADMIN_ACTIONS]])
    )
);

const actionPriority = new Set(ADMIN_ACTIONS);
const sectionPriority = new Set(ADMIN_PERMISSION_SECTIONS);

export const sanitizeAdminPermissions = (raw = {}) => {
    const normalized = {};

    for (const section of ADMIN_PERMISSION_SECTIONS) {
        const sectionActions = Array.isArray(raw?.[section]) ? raw[section] : [];
        normalized[section] = [...new Set(sectionActions.map((it) => String(it).trim().toLowerCase()))]
            .filter((it) => actionPriority.has(it));
    }

    return normalized;
};

export const isValidPermissionPayload = (payload = {}) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;

    for (const [section, actions] of Object.entries(payload)) {
        if (!sectionPriority.has(section)) return false;
        if (!Array.isArray(actions)) return false;
        if (actions.some((action) => !actionPriority.has(String(action).trim().toLowerCase()))) return false;
    }

    return true;
};

/**
 * The account type to assume when a row does not carry one.
 *
 * The schema defaults adminType to 'super_admin', but rows written straight to
 * the collection never see that default — scripts/create-admin-by-email.cjs is
 * one, and it is the documented way to create the first admin. Those rows load
 * with adminType undefined.
 *
 * Backend authorization already reads that as a super admin (isSuperAdmin in
 * roles/adminPermission.middleware.js, and the login token payload), so this
 * matches what the API actually enforces rather than introducing a third
 * opinion. The panel is strict — it grants nothing without an explicit
 * 'super_admin' — so leaving the two to disagree signed the account in with
 * full API access and an empty permission set, and every page bounced it back.
 */
export const DEFAULT_ADMIN_TYPE = 'super_admin';

/** Reads an admin's type, falling back for rows saved without one. */
export const normalizeAdminType = (adminType) => {
    const normalized = String(adminType || '').trim().toLowerCase();
    return normalized || DEFAULT_ADMIN_TYPE;
};

export const isSuperAdminType = (adminType) => normalizeAdminType(adminType) === 'super_admin';

/**
 * The permission set the panel should act on: everything for a super admin,
 * the stored grants otherwise. The single source for both login and /me, which
 * previously computed this separately and could drift.
 */
export const resolveEffectivePermissions = (admin = {}) =>
    (isSuperAdminType(admin?.adminType)
        ? ADMIN_FULL_PERMISSIONS
        : sanitizeAdminPermissions(admin?.permissions || {}));
