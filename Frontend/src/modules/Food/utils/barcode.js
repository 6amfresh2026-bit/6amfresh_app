/**
 * Barcodes, drawn as inline SVG.
 *
 * Two symbologies, picked from the value:
 *  - EAN-13 for a valid 13-digit retail code. It is what the barcodes this app
 *    generates for products are, and what a shop's scanner is built around.
 *  - Code 128 (set B) for everything else: bill numbers, item codes like
 *    "PRD0000000042", a supplier's own codes. Any printable ASCII.
 *
 * Both are produced as a list of bars first (encodeBars), so the SVG, the label
 * sheet and the tests all draw from the same thing.
 */

// Code 128 bar/space widths, values 0-106. Standard table; the last entry is
// the 7-module stop pattern.
const CODE128_PATTERNS = ("212222222122222221121223121322131222122213122312132212221213221312231212112232122132122231113222123122" +
  "123221223211221132221231213212223112312131311222321122321221312212322112322211212123212321232121111323131123131321" +
  "112313132113132311211313231113231311112133112331132131113123113321133121313121211331231131213113213311213131311123" +
  "311321331121312113312311332111314111221411431111111224111422121124121421141122141221112214112412122114122411142112" +
  "142211241211221114413111241112134111111242121142121241114212124112124211411212421112421211212141214121412121111143" +
  "111341131141114113114311411113411311113141114131311141411131211412211214211232").match(/.{6}/g).concat(["2331112"])

const ean13CheckDigit = (first12) => {
  const sum = [...first12].reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 1 : 3), 0)
  return (10 - (sum % 10)) % 10
}

/** A 13-digit string whose last digit is the right check digit for the first twelve. */
export const isValidEan13 = (value) => {
  const v = String(value ?? "")
  return /^\d{13}$/.test(v) && ean13CheckDigit(v.slice(0, 12)) === Number(v[12])
}

/** Completes 12 digits into an EAN-13. */
export const withEan13CheckDigit = (first12) => {
  const v = String(first12 ?? "")
  if (!/^\d{12}$/.test(v)) throw new Error("EAN-13 needs exactly 12 digits before the check digit")
  return v + ean13CheckDigit(v)
}

const EAN_L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"]
const EAN_G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"]
const EAN_R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"]
// Which of L/G each of the six left-hand digits uses, chosen by the first digit.
const EAN_PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"]

/** Collapses a string of 0/1 modules into [{ x, w }] bars, in module units. */
const barsFromModules = (modules) => {
  const bars = []
  let x = 0
  while (x < modules.length) {
    if (modules[x] === "1") {
      let w = 1
      while (modules[x + w] === "1") w += 1
      bars.push({ x, w })
      x += w
    } else {
      x += 1
    }
  }
  return { bars, width: modules.length }
}

const ean13Bars = (value) => {
  const digits = [...value].map(Number)
  const parity = EAN_PARITY[digits[0]]
  let modules = "101"
  for (let i = 0; i < 6; i += 1) modules += (parity[i] === "L" ? EAN_L : EAN_G)[digits[i + 1]]
  modules += "01010"
  for (let i = 7; i < 13; i += 1) modules += EAN_R[digits[i]]
  modules += "101"
  return barsFromModules(modules)
}

const code128Bars = (value) => {
  const codes = [104] // Start B
  for (const ch of value) codes.push(ch.charCodeAt(0) - 32)
  // Checksum is position-weighted from the start character, which counts as 1.
  const checksum = codes.reduce((sum, code, i) => sum + code * (i === 0 ? 1 : i), 0) % 103
  codes.push(checksum, 106) // and Stop

  const bars = []
  let x = 0
  for (const code of codes) {
    const widths = CODE128_PATTERNS[code]
    if (!widths) continue
    for (let i = 0; i < widths.length; i += 1) {
      const w = Number(widths[i])
      if (i % 2 === 0) bars.push({ x, w })
      x += w
    }
  }
  return { bars, width: x }
}

/** Printable ASCII only, which is all Code 128 set B can carry. */
const cleanText = (text) => String(text ?? "").replace(/[^\x20-\x7e]/g, "")

/**
 * The bars for a value, in module units: { format, value, bars: [{ x, w }], width }.
 * Null when there is nothing to encode.
 */
export const encodeBars = (text) => {
  const value = cleanText(text)
  if (!value) return null
  if (isValidEan13(value)) return { format: "ean13", value, ...ean13Bars(value) }
  return { format: "code128", value, ...code128Bars(value) }
}

export const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch])

/**
 * A scannable barcode as inline SVG ("" when there is nothing to draw).
 *
 * `module` is the width of the thinnest bar in px. On a screen, use a whole number: a
 * fractional bar blurs when drawn and a camera cannot read it (printing is unaffected). `showText` adds the value
 * underneath, which a label needs so a person can type it when a scan fails. `stretch` makes the
 * drawing fill whatever box it is put in (width and height 100%): only the bars' widths relative
 * to one another matter to a scanner, so stretching sideways is safe, and a label can then give the
 * barcode all the width it has.
 */
export const barcodeSvg = (text, { height = 44, module = 1.4, showText = false, stretch = false } = {}) => {
  const encoded = encodeBars(text)
  if (!encoded) return ""

  const bars = encoded.bars
    .map((b) => `<rect x="${(b.x * module).toFixed(2)}" y="0" width="${(b.w * module).toFixed(2)}" height="${height}"/>`)
    .join("")
  const barsWidth = encoded.width * module
  // A quiet zone either side, without which many scanners will not read it.
  const quiet = 10 * module
  const totalWidth = barsWidth + quiet * 2
  const fontSize = Math.max(8, Math.round(module * 7))
  const textHeight = showText ? fontSize + 3 : 0
  const totalHeight = height + textHeight
  const label = showText
    ? `<text x="${(barsWidth / 2).toFixed(2)}" y="${height + fontSize}" text-anchor="middle" font-family="monospace" font-size="${fontSize}">${escapeXml(encoded.value)}</text>`
    : ""

  const size = stretch ? `width="100%" height="100%" preserveAspectRatio="none"` : `width="${totalWidth.toFixed(2)}" height="${totalHeight}"`
  return `<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="${(-quiet).toFixed(2)} 0 ${totalWidth.toFixed(2)} ${totalHeight}" fill="#000">${bars}${label}</svg>`
}

export const LABEL_SIZES = [
  { id: "50x30", label: "50 × 30 mm", widthMm: 50, heightMm: 30 },
  { id: "38x25", label: "38 × 25 mm", widthMm: 38, heightMm: 25 },
  { id: "40x20", label: "40 × 20 mm", widthMm: 40, heightMm: 20 },
]

/**
 * Pages of product labels, one label per page so a thermal label printer cuts
 * between them (a sheet printer simply gets a sheet of them).
 *
 * `labels` is [{ name, barcode, price, mrp, copies, unit }]. Anything without a
 * barcode is skipped: a label that cannot be scanned is worse than no label.
 */
export const labelsHtml = (labels, { widthMm = 50, heightMm = 30, storeName = "" } = {}) => {
  const money = (n) => (Number(n) || 0).toFixed(2).replace(/\.00$/, "")
  const pages = []
  for (const l of labels || []) {
    const svg = barcodeSvg(l.barcode, { height: 40, module: 1.4, showText: true })
    if (!svg) continue
    const copies = Math.min(Math.max(parseInt(l.copies, 10) || 1, 1), 500)
    const hasMrp = l.mrp != null && Number(l.mrp) > Number(l.price)
    const page = `<div class="label">
      ${storeName ? `<div class="store">${escapeXml(storeName)}</div>` : ""}
      <div class="name">${escapeXml(l.name || "")}${l.unit ? ` <span class="unit">${escapeXml(l.unit)}</span>` : ""}</div>
      <div class="bc">${svg}</div>
      <div class="price">${hasMrp ? `<s>MRP ₹${money(l.mrp)}</s> ` : ""}<b>₹${money(l.price)}</b></div>
    </div>`
    for (let i = 0; i < copies; i += 1) pages.push(page)
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>Barcode labels</title>
<style>
  @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; }
  .label { width: ${widthMm}mm; height: ${heightMm}mm; padding: 1.2mm 1.5mm; overflow: hidden; page-break-after: always;
    display: flex; flex-direction: column; justify-content: space-between; text-align: center; }
  .store { font-size: 6.5pt; text-transform: uppercase; letter-spacing: .02em; }
  .name { font-size: 8pt; font-weight: bold; line-height: 1.1; max-height: 2.4em; overflow: hidden; }
  .unit { font-weight: normal; font-size: 7pt; }
  .bc { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
  .bc svg { max-width: 100%; max-height: 100%; width: auto; height: auto; }
  .price { font-size: 9pt; }
  s { font-size: 7pt; }
  @media screen { body { background: #eee; } .label { background: #fff; margin: 6px auto; border: 1px dashed #bbb; } }
</style></head><body>${pages.join("")}<script>window.onload = function () { window.print(); };</script></body></html>`
}

/**
 * Prints the labels from their own window; false if the popup was blocked.
 *
 * Pass `target` - a window opened earlier in the same click - when the labels are only
 * known after an await (barcodes generated first). Browsers allow a popup for a moment
 * after a click, not after a network round trip, so open it first and fill it in later.
 */
export const printLabels = (labels, opts, target = null) => {
  const w = target || window.open("", "_blank", "width=480,height=640")
  if (!w) return false
  w.document.open()
  w.document.write(labelsHtml(labels, opts))
  w.document.close()
  return true
}

/** The blank window to hand to printLabels as `target`. Null if the browser blocks it. */
export const openLabelWindow = () => window.open("", "_blank", "width=480,height=640")
