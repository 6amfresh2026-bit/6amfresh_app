import { barcodeSvg } from "@food/utils/barcode"

/**
 * The POS receipt, built from a bill-design config.
 *
 * One builder feeds both the live preview and the "Download test bill" print
 * window, so what the admin tweaks is exactly what prints. The markup is plain
 * strings with classes; all the styling lives in RECEIPT_CSS, scoped under
 * `.rcpt` so it can be dropped into the page or a print document untouched.
 */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const money = (n) => Number(n || 0).toFixed(2)

// A fixed sample so the preview always has something representative to show.
export const SAMPLE = {
  store: {
    name: "Vijay Nagar Store",
    address: "Shop 12, 56 Dukan Road, Vijay Nagar, Indore, 452010",
    phone: "9811100001",
  },
  billNo: "VN-260042",
  date: "21/10/2026 04:01 pm",
  cashier: "Sneha Rao",
  customer: "Priya Sharma",
  customerPhone: "9000000002",
  table: "T-4",
  items: [
    { name: "Basmati Rice", pack: "5 kg", qty: "1", rate: 520, amt: 520 },
    { name: "Toned Milk", pack: "500 ml", qty: "2", rate: 34, amt: 68 },
    { name: "Tomato", pack: "", qty: "1.250kg", rate: 40, amt: 50 },
    { name: "Detergent", pack: "1 kg", qty: "1", rate: 120, amt: 120 },
    { name: "Biscuits", pack: "200 g", qty: "1", rate: 30, amt: 30 },
  ],
  itemsCount: 5,
  qtyCount: "6.25",
  totalMrp: 840,
  youSaved: 52,
  total: 788,
  gst: [
    { pct: "0", taxable: 118.0, cgst: 0.0, sgst: 0.0 },
    { pct: "5", taxable: 495.24, cgst: 12.38, sgst: 12.38 },
    { pct: "12", taxable: 26.79, cgst: 1.61, sgst: 1.61 },
    { pct: "18", taxable: 101.69, cgst: 9.15, sgst: 9.15 },
  ],
  gstIncluded: 46.28,
  paidVia: "UPI",
  loyalty: 7,
}

export const RECEIPT_CSS = `
.rcpt { color:#111; background:#fff; width:80mm; max-width:100%; margin:0 auto; padding:6mm 5mm;
  font-family:"Courier New",ui-monospace,monospace; font-size:12px; line-height:1.45; box-sizing:border-box; }
.rcpt.w58 { width:58mm; }
.rcpt.sans { font-family:Arial,Helvetica,sans-serif; }
.rcpt.sm { font-size:10.5px; }
.rcpt.lg { font-size:13.5px; }
.rcpt .biz { font-size:1.7em; font-weight:700; letter-spacing:.12em; }
.rcpt .center { text-align:center; }
.rcpt .left { text-align:left; }
.rcpt .muted { white-space:pre-wrap; }
.rcpt .title { font-weight:700; letter-spacing:.08em; text-align:center; margin:2px 0; }
.rcpt .div { margin:6px 0; border:0; border-top:1px dashed #333; height:0; }
.rcpt.div-solid .div { border-top:1px solid #333; }
.rcpt.div-none .div { border-top:0; margin:4px 0; }
.rcpt .kv { display:flex; justify-content:space-between; gap:8px; }
.rcpt .kv span:last-child { text-align:right; }
.rcpt .cols-head, .rcpt .item { display:grid; grid-template-columns:1fr 150px; gap:4px; }
.rcpt .nums { display:grid; grid-template-columns:1fr 1fr 1fr; text-align:right; gap:6px; }
.rcpt .item { margin-top:5px; }
.rcpt .pack { color:#555; }
.rcpt .total { display:flex; justify-content:space-between; align-items:center; margin:4px 0; }
.rcpt.bold-total .total { font-weight:700; font-size:1.25em; }
.rcpt .gst { margin-top:4px; }
.rcpt .gst .grow { display:grid; grid-template-columns:40px 1fr 1fr 1fr; gap:4px; text-align:right; }
.rcpt .gst .grow span:first-child { text-align:left; }
.rcpt .foot { text-align:center; white-space:pre-wrap; }
.rcpt .bc { text-align:center; margin-top:6px; }
.rcpt .bc svg { max-width:70%; height:auto; }
.rcpt .bc .bcnum { font-size:.85em; letter-spacing:.1em; margin-top:2px; }
`

const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><span>${esc(v)}</span></div>`

export function receiptBody(config = {}, sample = SAMPLE) {
  const c = config
  const s = sample
  const money2 = (n) => money(n)
  const bizName = c.businessName || s.store.name || "Your Store"
  const headAlign = c.headingAlign === "left" ? "left" : "center"

  const head = []
  if (c.logoUrl) head.push(`<div class="center"><img src="${esc(c.logoUrl)}" alt="" style="max-height:${Number(c.logoHeight) || 44}px;max-width:70%"/></div>`)
  head.push(`<div class="biz ${headAlign}">${esc(bizName)}</div>`)
  if (c.tagline) head.push(`<div class="${headAlign}">${esc(c.tagline)}</div>`)
  // Only print the store name as its own line when a distinct business name sits
  // above it — otherwise the big heading already is the store name.
  if (c.showStoreName && bizName !== s.store.name) head.push(`<div class="${headAlign}">${esc(s.store.name)}</div>`)
  if (c.showStoreAddress) head.push(`<div class="${headAlign} muted">${esc(s.store.address)}</div>`)
  if (c.showStorePhone) head.push(`<div class="${headAlign}">Ph: ${esc(s.store.phone)}</div>`)

  const detail = []
  if (c.showBillNo) detail.push(kv("Bill No", s.billNo))
  if (c.showDateTime) detail.push(kv("Date", s.date))
  if (c.showCashier) detail.push(kv("Cashier", s.cashier))
  if (c.showCustomerName) detail.push(kv("Customer", s.customer))
  if (c.showCustomerPhone) detail.push(kv("Phone", s.customerPhone))
  if (c.showTable) detail.push(kv("Table", s.table))

  const itemsHead = `<div class="cols-head"><span>Item</span><div class="nums"><span>Qty</span><span>Rate</span><span>Amt</span></div></div>`
  const itemRows = s.items
    .map(
      (it) => `<div class="item"><div>${esc(it.name)}${c.showPackSize && it.pack ? ` <span class="pack">${esc(it.pack)}</span>` : ""}</div>` +
        `<div class="nums"><span>${esc(it.qty)}</span><span>${money2(it.rate)}</span><span>${money2(it.amt)}</span></div></div>`
    )
    .join("")

  const totals = []
  if (c.showItemsQty) totals.push(kv("Items / Qty", `${s.itemsCount} / ${s.qtyCount}`))
  if (c.showTotalMrp) totals.push(kv("Total MRP", money2(s.totalMrp)))
  if (c.showYouSaved) totals.push(kv("You saved", money2(s.youSaved)))

  const totalLine = `<div class="total"><span>TOTAL</span><span>₹${money2(s.total)}</span></div>`

  let gst = ""
  if (c.showGstTable) {
    const rows = s.gst
      .map((g) => `<div class="grow"><span>${esc(g.pct)}</span><span>${money2(g.taxable)}</span><span>${money2(g.cgst)}</span><span>${money2(g.sgst)}</span></div>`)
      .join("")
    gst = `<div class="gst"><div class="grow"><span>GST%</span><span>Taxable</span><span>CGST</span><span>SGST</span></div>${rows}` +
      (c.showGstIncluded ? `<div class="kv" style="margin-top:2px"><span></span><span>GST included: ${money2(s.gstIncluded)}</span></div>` : "") +
      `</div>`
  } else if (c.showGstIncluded) {
    gst = `<div class="kv"><span></span><span>GST included: ${money2(s.gstIncluded)}</span></div>`
  }

  const pay = []
  if (c.showPayment) pay.push(kv(`Paid · ${s.paidVia}`, money2(s.total)))
  if (c.showLoyalty) pay.push(kv("Loyalty earned", `${s.loyalty} pts`))

  const foot = []
  if (c.thankYou) foot.push(`<div class="foot">${esc(c.thankYou)}</div>`)
  if (c.extraNote) foot.push(`<div class="foot">${esc(c.extraNote)}</div>`)
  if (c.termsLine) foot.push(`<div class="foot">${esc(c.termsLine)}</div>`)
  const barcode = c.showBarcode
    ? `<div class="bc">${barcodeSvg(s.billNo, { height: 42, module: 1.3 }) || ""}<div class="bcnum">${esc(s.billNo)}</div></div>`
    : ""

  const div = `<hr class="div"/>`
  const parts = [
    head.join(""),
    c.billTitle ? `<div class="title">${esc(c.billTitle)}</div>` : "",
    c.gstin ? `<div class="${headAlign}">GSTIN: ${esc(c.gstin)}</div>` : "",
    c.extraHeader ? `<div class="${headAlign} muted">${esc(c.extraHeader)}</div>` : "",
    div,
    detail.join(""),
    detail.length ? div : "",
    itemsHead,
    itemRows,
    div,
    totals.join(""),
    totalLine,
    gst,
    (pay.length ? div + pay.join("") : ""),
    div,
    foot.join(""),
    barcode,
  ]
  return parts.filter(Boolean).join("")
}

/** Wrapper modifier classes for the paper, from the config. */
export function receiptClasses(config = {}) {
  const w = config.paperWidth === "58" ? "w58" : "" // "pos" and "80" both print 80 mm here
  const font = config.font === "sans" ? "sans" : ""
  const size = config.textSize === "small" ? "sm" : config.textSize === "large" ? "lg" : ""
  const div = config.dividers === "solid" ? "div-solid" : config.dividers === "none" ? "div-none" : ""
  const bold = config.boldTotal ? "bold-total" : ""
  return ["rcpt", w, font, size, div, bold].filter(Boolean).join(" ")
}

/** A standalone printable document — opened and printed by "Download test bill". */
export function receiptDoc(config = {}, sample = SAMPLE) {
  const widthMm = config.paperWidth === "58" ? 58 : 80
  return `<!doctype html><html><head><meta charset="utf-8"><title>Test bill</title>
<style>
  @page { size:${widthMm}mm auto; margin:0; }
  html,body { margin:0; background:#fff; }
  ${RECEIPT_CSS}
  .rcpt { box-shadow:none; }
  @media screen { body { background:#eee; padding:10px; } .rcpt { box-shadow:0 1px 6px rgba(0,0,0,.2); } }
</style></head><body>
  <div class="${receiptClasses(config)}">${receiptBody(config, sample)}</div>
  <script>window.onload=function(){window.print()}</script>
</body></html>`
}
