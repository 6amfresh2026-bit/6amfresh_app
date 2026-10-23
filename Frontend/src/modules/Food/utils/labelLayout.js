import { barcodeSvg, escapeXml, isValidEan13 } from "./barcode"

/**
 * Product labels: what goes on one, how labels are laid out on a page, and the printable page.
 *
 * Kept free of React so the arithmetic (how many labels fit, where the margins fall) can be
 * tested, and so the on-screen preview, the browser print and the PDF all start from the same
 * label model and the same layout table.
 */

/**
 * Every layout is one of:
 *  - "sheet": a sheet of adhesive labels on A4. `cols` x `rows` labels of `widthMm` x `heightMm`,
 *    centred on the page, so the cut-outs line up when printed at 100% scale.
 *  - "roll": one label per page, for a thermal label printer.
 */
export const A4 = { pageWidthMm: 210, pageHeightMm: 297 }

export const LABEL_LAYOUTS = [
  { id: "a4-24", kind: "sheet", label: "A4 sheet · 24 labels (3 × 8, 70 × 37 mm)", cols: 3, rows: 8, widthMm: 70, heightMm: 37, ...A4 },
  { id: "a4-40", kind: "sheet", label: "A4 sheet · 40 labels (4 × 10, 52.5 × 29.7 mm)", cols: 4, rows: 10, widthMm: 52.5, heightMm: 29.7, ...A4 },
  { id: "a4-65", kind: "sheet", label: "A4 sheet · 65 labels (5 × 13, 38.1 × 21.2 mm)", cols: 5, rows: 13, widthMm: 38.1, heightMm: 21.2, ...A4 },
  { id: "roll-50x30", kind: "roll", label: "Label roll · 50 × 30 mm", widthMm: 50, heightMm: 30 },
  { id: "roll-38x25", kind: "roll", label: "Label roll · 38 × 25 mm", widthMm: 38, heightMm: 25 },
  { id: "roll-40x20", kind: "roll", label: "Label roll · 40 × 20 mm", widthMm: 40, heightMm: 20 },
]

export const getLayout = (id) => LABEL_LAYOUTS.find((l) => l.id === id) || LABEL_LAYOUTS[0]

/** Labels per physical page. */
export const labelsPerPage = (layout) => (layout.kind === "sheet" ? layout.cols * layout.rows : 1)

/** The page size, and where the grid of labels starts on it. */
export const pageGeometry = (layout) => {
  if (layout.kind === "roll") {
    return { pageWidthMm: layout.widthMm, pageHeightMm: layout.heightMm, marginXMm: 0, marginYMm: 0 }
  }
  return {
    pageWidthMm: layout.pageWidthMm,
    pageHeightMm: layout.pageHeightMm,
    marginXMm: Math.max(0, (layout.pageWidthMm - layout.cols * layout.widthMm) / 2),
    marginYMm: Math.max(0, (layout.pageHeightMm - layout.rows * layout.heightMm) / 2),
  }
}

export const DEFAULT_OPTIONS = { showPrice: true, showMrp: true, packed: false, expiry: false, guides: false }

/** Hard stop so a mistyped copy count cannot build a document the browser chokes on. */
export const MAX_COPIES = 500
export const MAX_LABELS = 2000

const amount = (n) => (Number(n) || 0).toFixed(2).replace(/\.00$/, "")
const pad2 = (n) => String(n).padStart(2, "0")

/** dd/mm/yyyy, or "" for anything that is not a date. */
export const formatDate = (value) => {
  if (!value) return ""
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`
}

/** The digits as printed under a barcode: an EAN-13 in its usual 1 · 6 · 6 grouping. */
export const humanCode = (code) => {
  const v = String(code ?? "")
  return isValidEan13(v) ? `${v[0]} ${v.slice(1, 7)} ${v.slice(7)}` : v
}

/**
 * One label's content from a product row ({ name, unit, barcode, price, mrp, expiryDate }) and the
 * chosen options. A product with no barcode yields null: a label that cannot be scanned is skipped.
 *
 * MRP is struck through only when it is above the selling price (that is the saving the shopper
 * sees). With the selling price hidden, MRP is the price shown, so it is not struck.
 */
export const buildLabel = (row, options = {}, today = new Date()) => {
  const o = { ...DEFAULT_OPTIONS, ...options }
  const barcode = String(row?.barcode ?? "").trim()
  if (!barcode) return null

  const price = row.price == null || row.price === "" ? null : Number(row.price)
  const mrp = row.mrp == null || row.mrp === "" ? null : Number(row.mrp)
  const priceText = o.showPrice && price != null && Number.isFinite(price) ? `₹${amount(price)}` : ""

  let mrpText = ""
  let mrpStruck = false
  if (o.showMrp && mrp != null && Number.isFinite(mrp) && mrp > 0) {
    if (priceText && mrp > price) {
      mrpText = `MRP ₹${amount(mrp)}`
      mrpStruck = true
    } else if (!priceText) {
      mrpText = `MRP ₹${amount(mrp)}`
    }
  }

  return {
    name: String(row.name ?? ""),
    unit: String(row.unit ?? ""),
    barcode,
    human: humanCode(barcode),
    priceText,
    mrpText,
    mrpStruck,
    packed: o.packed ? formatDate(today) : "",
    expiry: o.expiry ? formatDate(row.expiryDate) : "",
    copies: Math.min(Math.max(parseInt(row.copies, 10) || 1, 1), MAX_COPIES),
  }
}

/** Repeats each label by its copies, up to MAX_LABELS in all. */
export const expandCopies = (labels) => {
  const flat = []
  for (const l of labels) {
    for (let i = 0; i < l.copies && flat.length < MAX_LABELS; i += 1) flat.push(l)
  }
  return flat
}

/** Splits a flat list of labels into pages for the layout. */
export const paginate = (flat, layout) => {
  const per = labelsPerPage(layout)
  const pages = []
  for (let i = 0; i < flat.length; i += per) pages.push(flat.slice(i, i + per))
  return pages
}

export const LABEL_CSS = `
.lbl{width:100%;height:100%;box-sizing:border-box;padding:1.2mm 1.6mm;display:flex;flex-direction:column;overflow:hidden;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif}
.lbl .r1{display:flex;justify-content:space-between;align-items:baseline;gap:2mm}
.lbl .nm{font-weight:700;font-size:8.5pt;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.lbl .pr{font-weight:700;font-size:11pt;white-space:nowrap}
.lbl .r2{font-size:7pt;color:#222;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lbl .r2 s{margin-left:.6mm}
.lbl .bc{flex:1;min-height:0;margin:.8mm 0}
.lbl .bc svg{display:block;width:100%;height:100%}
.lbl .hc{text-align:center;font-family:"Courier New",monospace;font-size:8pt;letter-spacing:.12em;line-height:1.1}
.lbl .dt{display:flex;justify-content:space-between;font-size:6.5pt;margin-top:.4mm}
.lbl.sm{padding:.8mm 1.2mm}
.lbl.sm .nm{font-size:6.5pt}.lbl.sm .pr{font-size:8pt}.lbl.sm .r2{font-size:5.5pt}.lbl.sm .hc{font-size:6pt}.lbl.sm .dt{font-size:5pt}
`

/** One label as HTML. Every value is escaped; the barcode is our own SVG. */
export const labelHtml = (label, layout) => {
  const small = layout.heightMm < 26 ? " sm" : ""
  const meta = [label.unit ? escapeXml(label.unit) : "", label.mrpText ? (label.mrpStruck ? `<s>${escapeXml(label.mrpText)}</s>` : escapeXml(label.mrpText)) : ""]
    .filter(Boolean)
    .join(" · ")
  const dates =
    label.packed || label.expiry
      ? `<div class="dt"><span>${label.packed ? `Packed: ${escapeXml(label.packed)}` : ""}</span><span>${label.expiry ? `Exp: ${escapeXml(label.expiry)}` : ""}</span></div>`
      : ""
  return `<div class="lbl${small}">
<div class="r1"><span class="nm">${escapeXml(label.name)}</span><span class="pr">${escapeXml(label.priceText)}</span></div>
<div class="r2">${meta || "&nbsp;"}</div>
<div class="bc">${barcodeSvg(label.barcode, { height: 40, module: 1.4, stretch: true })}</div>
<div class="hc">${escapeXml(label.human)}</div>
${dates}
</div>`
}

const mm = (n) => `${Number(n.toFixed(2))}mm`

/**
 * The printable document: every label placed on its page.
 *
 * Sheets are printed at 100% scale from the browser ("Fit to page" off) so the grid lands on the
 * die-cuts; `guides` draws a dashed outline round each label for plain paper that is cut by hand.
 */
export const labelSheetHtml = (flat, layout, { guides = false, autoPrint = true } = {}) => {
  const g = pageGeometry(layout)
  const pages = paginate(flat, layout)
  const isSheet = layout.kind === "sheet"

  const body = pages
    .map(
      (page) =>
        `<div class="page">${page.map((label) => `<div class="cell">${labelHtml(label, layout)}</div>`).join("")}</div>`,
    )
    .join("")

  const grid = isSheet
    ? `display:grid;grid-template-columns:repeat(${layout.cols},${mm(layout.widthMm)});grid-auto-rows:${mm(layout.heightMm)};padding:${mm(g.marginYMm)} ${mm(g.marginXMm)};`
    : ""

  return `<!doctype html><html><head><meta charset="utf-8"><title>Barcode labels</title>
<style>
@page{size:${mm(g.pageWidthMm)} ${mm(g.pageHeightMm)};margin:0}
*{box-sizing:border-box}
body{margin:0}
.page{width:${mm(g.pageWidthMm)};height:${mm(g.pageHeightMm)};overflow:hidden;page-break-after:always;break-after:page;${grid}}
.page:last-child{page-break-after:auto;break-after:auto}
.cell{width:${mm(layout.widthMm)};height:${mm(layout.heightMm)};overflow:hidden;${guides ? "outline:.2mm dashed #9ca3af;outline-offset:-.1mm;" : ""}}
${LABEL_CSS}
@media screen{body{background:#e5e7eb}.page{margin:8px auto;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25)}}
</style></head><body>${body}${autoPrint ? "<script>window.onload=function(){window.print()}</script>" : ""}</body></html>`
}
