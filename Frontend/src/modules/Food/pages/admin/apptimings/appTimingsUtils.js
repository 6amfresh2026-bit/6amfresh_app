/**
 * Wording and small decisions for the "App timings & store status" screen, kept apart from the
 * component so they can be tested.
 */

/** "11s ago", "5m ago", "3h ago", "2d ago". */
export const formatAgo = (seconds) => {
  // null / undefined / "" are "no time", not zero: Number(null) is 0, which would read "0s ago".
  if (seconds == null || seconds === "") return ""
  const s = Number(seconds)
  if (!Number.isFinite(s) || s < 0) return ""
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** The till chip: online with how recently it checked in, or offline with when it last did. */
export const posChip = (store) => {
  const pos = store?.pos || {}
  if (pos.online) return { tone: "green", text: `POS online · seen ${formatAgo(pos.secondsAgo)}` }
  if (pos.secondsAgo == null) return { tone: "red", text: "POS offline · never seen" }
  return { tone: "red", text: `POS offline · last seen ${formatAgo(pos.secondsAgo)}` }
}

export const customerChip = (store) =>
  store?.customerOpen ? { tone: "green", text: "Customer app open" } : { tone: "gray", text: "Customer app closed" }

export const instantChip = (store) =>
  store?.instantLive ? { tone: "green", text: "Instant live" } : { tone: "gray", text: "Instant off" }

const REASON_TEXT = {
  "app-forced-closed": "App: closed by the admin",
  "app-outside-hours": "App: outside the app timings",
  "pos-offline": "App: POS is offline",
  "not-accepting-orders": "App: the store has paused orders",
  inactive: "App: the store is deactivated",
  "outside-hours": "App: outside the store's own hours",
  "no-timings": "App: the store has no opening hours set",
  "closed-day": "App: the store is closed today",
}

/** Why the customer app is closed, as a short line. Empty while it is open. */
export const closedReasonText = (store) => (store?.customerOpen ? "" : REASON_TEXT[store?.reason] || "App: closed")

const FIELDS = [
  "customerMode",
  "openTime",
  "closeTime",
  "instantMode",
  "instantFrom",
  "instantTo",
  "closedMessage",
  "requirePosOnline",
]

/** The fields in `draft` that differ from what is saved: exactly what a save should send. */
export const buildPatch = (saved, draft) => {
  const patch = {}
  if (!draft) return patch
  for (const key of FIELDS) {
    if (draft[key] !== undefined && draft[key] !== (saved?.[key] ?? undefined)) patch[key] = draft[key]
  }
  return patch
}

export const isDirty = (saved, draft) => Object.keys(buildPatch(saved, draft)).length > 0

/** Is a window complete? Both ends or neither: half a window is rejected by the server. */
export const windowProblem = (from, to, label) => {
  if (Boolean(from) !== Boolean(to)) return `Set both the ${label} start and end time, or clear both`
  return ""
}

/** What stops this draft being saved, in words; empty when it can be. */
export const draftProblem = (draft) => {
  if (!draft) return ""
  return (
    windowProblem(draft.openTime, draft.closeTime, "app") ||
    windowProblem(draft.instantFrom, draft.instantTo, "instant") ||
    (String(draft.closedMessage || "").length > 280 ? "The closed message can be at most 280 characters" : "")
  )
}
