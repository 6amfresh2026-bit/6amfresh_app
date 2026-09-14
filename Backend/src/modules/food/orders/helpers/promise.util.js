/**
 * The delivery promise: what the customer was told, and whether it was kept.
 *
 * Deliberately dependency-free. Both the order model (whose pre-save hook
 * settles the promise the moment an order stops moving) and the order services
 * read from here, and the model cannot import the service helpers without a
 * cycle. Keeping the rules in one leaf module is also what stops the two from
 * drifting into two different definitions of "on time".
 */

/**
 * Records the promise the customer was shown, on the order that was placed.
 *
 * Called once at creation with the quote the customer actually saw, so the
 * deadline is fixed at the moment of the sale. Recomputing it later is not the
 * same thing: distance, fee bands and the packing constant all move, and the
 * honest question is whether *the number the customer saw* was met.
 *
 * `quotedAt` is the booked window when there is one, so a 7 AM round arranged
 * at midnight is not seven hours late the moment it is created.
 */
export function buildOrderPromise({ quotedMinutes, quotedAt, distanceKm = null } = {}) {
  const minutes = Number(quotedMinutes);
  const from = quotedAt instanceof Date ? quotedAt : new Date(quotedAt || Date.now());

  // No usable quote is recorded as no promise at all. Storing a zero would
  // quietly turn "we never told them" into "we promised immediately".
  if (!Number.isFinite(minutes) || minutes <= 0 || Number.isNaN(from.getTime())) {
    return {
      quotedMinutes: null,
      quotedAt: null,
      dueBy: null,
      distanceKm: null,
      outcome: 'not_applicable',
      varianceSeconds: null,
    };
  }

  const whole = Math.ceil(minutes);
  return {
    quotedMinutes: whole,
    quotedAt: from,
    dueBy: new Date(from.getTime() + whole * 60 * 1000),
    // Number(null) is 0, so a plain isFinite check would record "we never
    // measured the distance" as "the customer is at the door".
    distanceKm:
      distanceKm === null || distanceKm === undefined || distanceKm === '' || !Number.isFinite(Number(distanceKm))
        ? null
        : Number(distanceKm),
    outcome: 'pending',
    varianceSeconds: null,
  };
}

/**
 * Works out how a promise ended, given the status the order settled into.
 *
 * A cancelled order is 'not_applicable', not 'late'. A cancellation is its own
 * failure, and folding it into the on-time rate would make that number mean
 * two different things at once — you could improve it by cancelling more.
 *
 * Returns the unchanged promise when there is nothing to settle, so callers
 * can apply it unconditionally: an order that carried no promise keeps none,
 * and one already settled is never re-scored by a replayed webhook or a second
 * sweep.
 */
export function resolveOrderPromise(promise, { at = new Date(), status } = {}) {
  const current = promise || {};
  if (current.outcome !== 'pending') return current;

  const next = { ...current };

  if (String(status || '') !== 'delivered' || !current.dueBy) {
    next.outcome = 'not_applicable';
    return next;
  }

  const deliveredAt = at instanceof Date ? at : new Date(at);
  const due = new Date(current.dueBy);
  if (Number.isNaN(deliveredAt.getTime()) || Number.isNaN(due.getTime())) {
    next.outcome = 'not_applicable';
    return next;
  }

  // Signed seconds against the deadline: negative is early, positive is late.
  // Stored so a report is a sum rather than a per-row date subtraction across
  // two optional fields.
  next.varianceSeconds = Math.round((deliveredAt.getTime() - due.getTime()) / 1000);
  next.outcome = next.varianceSeconds <= 0 ? 'on_time' : 'late';
  return next;
}

/** Terminal states, repeated here so this module stays a leaf. */
export const PROMISE_TERMINAL_STATUSES = [
  'delivered',
  'cancelled_by_user',
  'cancelled_by_restaurant',
  'cancelled_by_admin',
];
