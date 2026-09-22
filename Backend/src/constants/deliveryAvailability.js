/**
 * What a delivery partner's availability can say, and which of those states
 * dispatch is allowed to send work to.
 *
 * Only `online` is dispatchable. Every other value — including the ones added
 * for short interruptions — is a rider who should not be offered a new order.
 * That is enforced by the dispatch queries filtering on `availabilityStatus:
 * 'online'` rather than on "not offline", so a mode added here stops new
 * assignments by construction and cannot be forgotten in one of the three
 * places that ask.
 *
 * The interruption modes are deliberately distinct from `offline`: a rider in
 * the washroom for two minutes and a rider who has gone home for the night
 * both stop receiving orders, but only one of them is a staffing problem, and
 * ops cannot tell them apart if both are just "offline".
 */

/** The only state dispatch will offer an order to. */
export const DISPATCHABLE_AVAILABILITY = 'online';

/**
 * Short interruptions. The rider is still on shift and still holds whatever
 * they have already accepted; they are only closed to new work.
 */
export const AVAILABILITY_PAUSE_MODES = Object.freeze([
    'on_break',
    'washroom',
    'emergency',
    'vehicle_issue',
    'cannot_collect',
]);

export const DELIVERY_AVAILABILITY_STATUSES = Object.freeze([
    'online',
    'offline',
    ...AVAILABILITY_PAUSE_MODES,
]);

/** For panels that have to name a state to a human. */
export const AVAILABILITY_LABELS = Object.freeze({
    online: 'Online',
    offline: 'Offline',
    on_break: 'On break',
    washroom: 'Washroom',
    emergency: 'Emergency',
    vehicle_issue: 'Vehicle problem',
    cannot_collect: 'Cannot collect',
});

export const isDispatchable = (status) => status === DISPATCHABLE_AVAILABILITY;

export const isPaused = (status) => AVAILABILITY_PAUSE_MODES.includes(status);

/**
 * Coerces whatever a client sent into a status this system recognises.
 *
 * Booleans and the strings "true"/"false" are accepted because existing rider
 * builds send the toggle that way. Anything unrecognised becomes `offline`,
 * which is the safe direction to fail: it stops orders rather than sending
 * them to a rider whose state nobody understood.
 */
export const normalizeAvailabilityStatus = (raw) => {
    if (raw === true || raw === 'true' || raw === 'online') return 'online';
    if (raw === false || raw === 'false' || raw === 'offline') return 'offline';
    const value = String(raw || '').trim().toLowerCase();
    return AVAILABILITY_PAUSE_MODES.includes(value) ? value : 'offline';
};
