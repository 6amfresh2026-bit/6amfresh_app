/**
 * What a counter scale sends, as kilograms.
 *
 * Scales differ, but the lines look alike: "ST,GS,   1.250 kg", "+001.250kg", "  0.500 g", or just
 * "1.250" when the unit is set on the scale. A line starting "US" (or carrying "UN") is an unstable
 * reading: the pan is still moving and the number must not be billed yet.
 */

export const SCALE_UNITS = ["kg", "g"]
export const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200]

const TO_KG = { kg: 1, kgs: 1, g: 0.001, gm: 0.001, gms: 0.001, lb: 0.45359237, lbs: 0.45359237, oz: 0.028349523 }
const round3 = (n) => Math.round(n * 1000) / 1000

/** One line from the scale -> { kg, stable } or null when it holds no weight. */
export const parseScaleLine = (line, defaultUnit = "kg") => {
  const text = String(line ?? "").trim()
  if (!text) return null
  const m = /([+-]?\s*\d+(?:\.\d+)?)\s*([a-z]{1,3})?/i.exec(text.replace(/^(ST|US|NT|GS|NET)\s*,?/gi, ""))
  if (!m) return null
  const value = Number(m[1].replace(/\s+/g, ""))
  if (!Number.isFinite(value)) return null
  const unit = (m[2] || "").toLowerCase()
  const factor = TO_KG[unit] ?? TO_KG[String(defaultUnit).toLowerCase()] ?? 1
  const stable = !/^\s*(US|UN)\b/i.test(text)
  return { kg: Math.max(0, round3(value * factor)), stable }
}

/**
 * Feeds raw serial text in, hands whole lines out. Scales end a reading with CR, LF or both, and a
 * chunk can end mid-line, so the unfinished tail is kept for the next chunk.
 */
export const createLineBuffer = (onLine) => {
  let rest = ""
  return (chunk) => {
    rest += chunk
    const parts = rest.split(/\r\n|\r|\n/)
    rest = parts.pop() ?? ""
    // A scale that never sends a terminator would grow this forever; a reading is never this long.
    if (rest.length > 200) rest = rest.slice(-40)
    for (const part of parts) if (part.trim()) onLine(part)
  }
}

/** Is this product sold by weight? Flagged as such, or priced per kilogram / gram. */
export const isWeighedItem = (item) => Boolean(item?.soldByWeight) || /^(kg|kgs|kilo|kilogram|g|gm|gms|gram|grams)\b/i.test(String(item?.unit || item?.packSize || "").trim())
