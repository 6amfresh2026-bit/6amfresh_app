/**
 * Small decisions for the POS users screen, kept apart from the component so they can be tested.
 * The rules mirror the server's (core/pos/posUser.service.js), which is what actually enforces them.
 */

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/
export const MIN_PASSWORD = 6

/** What stops this form being saved, in words; empty when it can be. */
export const userProblem = (form, { needPassword = true, needStore = true } = {}) => {
  const f = form || {}
  if (needStore && !f.restaurantId) return "Pick the store this person works at"
  if (!String(f.name || "").trim()) return "Enter the person's name"
  if (!USERNAME_RE.test(String(f.username || "").trim().toLowerCase())) {
    return "Username: 3-30 characters, letters, numbers, dot, dash or underscore"
  }
  if (needPassword && String(f.password || "").length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters`
  }
  return ""
}

// No look-alikes (0/O, 1/l/I): the admin reads this out or writes it down for someone else.
const PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"

/** A random 10-character password. Uses the browser's crypto, never Math.random. */
export const generatePassword = (length = 10) => {
  const bytes = new Uint32Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (n) => PASSWORD_CHARS[n % PASSWORD_CHARS.length]).join("")
}

/** "Never" or a short local date and time. */
export const formatLastLogin = (value) => {
  if (!value) return "Never"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "Never"
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
}

/** "2 Oct, 4:05 pm" or a dash. */
export const formatDateTime = (value) => {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
}

/** ₹1,234.50, with the paise only when there are some. */
export const money = (n) => {
  const v = Number(n) || 0
  return `${v < 0 ? "-" : ""}₹${Math.abs(v).toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`
}

const MODE_LABELS = { cash: "Cash", upi: "UPI", card: "Card", multiple: "Split", pay_later: "Pay later", credit_note: "Credit note", loyalty: "Loyalty" }
export const modeLabel = (mode) => MODE_LABELS[mode] || (mode ? String(mode).replace(/_/g, " ") : "—")

/** Colour of a bill status pill: done is green, cancelled red, anything else neutral. */
export const statusTone = (status) =>
  status === "delivered" ? "green" : String(status || "").startsWith("cancelled") ? "red" : "gray"

export const RANGES = [
  ["today", "Today"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["90d", "Last 90 days"],
]

const DAYS = { today: 0, "7d": 6, "30d": 29, "90d": 89 }

const isoDay = (d) => {
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** from/to query for a range key, in the viewer's own calendar days. */
export const rangeParams = (key, now = new Date()) => {
  const back = DAYS[key] ?? DAYS["30d"]
  const from = new Date(now)
  from.setDate(from.getDate() - back)
  return { from: isoDay(from), to: isoDay(now) }
}

/** Every permission key in a catalogue. */
export const allKeys = (groups = []) => groups.flatMap((g) => g.permissions.map((p) => p.key))

export const toggleKey = (selected, key) => (selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key])

/** Turns a whole group on, or off when it is already entirely on. */
export const toggleGroup = (selected, group) => {
  const keys = group.permissions.map((p) => p.key)
  return keys.every((k) => selected.includes(k))
    ? selected.filter((k) => !keys.includes(k))
    : [...new Set([...selected, ...keys])]
}

/** What is wrong with the two limits, in words; empty when they are fine. */
export const limitsProblem = (limits) => {
  const bill = Number(limits?.maxBillAmount === "" ? 0 : limits?.maxBillAmount)
  const pct = Number(limits?.maxDiscountPercent === "" ? 0 : limits?.maxDiscountPercent)
  if (!Number.isFinite(bill) || bill < 0) return "Bill limit must be 0 or more"
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return "Discount limit must be between 0 and 100"
  return ""
}
