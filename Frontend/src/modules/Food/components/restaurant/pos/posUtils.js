/**
 * Shared bits for the till: money formatting, the order-type and key maps,
 * line arithmetic, and the printable receipt.
 *
 * Line arithmetic here is only what the screen shows while the cashier is
 * typing; the amount actually charged comes back from the server's quote,
 * which is the same engine that will write the order.
 */

import { barcodeSvg } from "@food/utils/barcode"

// The drawing lives in utils/barcode.js; re-exported for the callers that import it here.
export { barcodeSvg }

export const ORDER_TYPES = [
  { value: "dine_in", label: "Dine In" },
  { value: "take_away", label: "Take Away" },
  { value: "walk_in", label: "Walk In" },
  { value: "delivery", label: "Delivery" },
]

export const ORDER_TYPE_LABEL = Object.fromEntries(ORDER_TYPES.map((t) => [t.value, t.label]))

export const TENDER_LABEL = { cash: "Cash", upi: "UPI", card: "Card", multiple: "Multiple", pay_later: "Pay Later" }

/** F-keys, exactly as printed on the buttons. */
export const KEY_ACTIONS = {
  F3: { mode: "card" },
  F4: { mode: "cash" },
  F5: { mode: "upi" },
  F6: { hold: true },
  F7: { hold: true, print: true },
  F8: { mode: "cash", print: true },
  F9: { mode: "card", print: true },
  F10: { mode: "upi", print: true },
  F11: { mode: "pay_later" },
  F12: { mode: "multiple" },
}

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

export const money = (n, digits = 1) => {
  const v = Number(n) || 0
  return v.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 2) })
}

export const fmtDateTime = (d) => {
  if (!d) return "-"
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

export const fmtDate = (d) => {
  if (!d) return "-"
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

/** The rupee discount on one line: a percentage of the gross plus a flat amount. */
export const lineDiscount = (line) => {
  const gross = (Number(line.price) || 0) * (Number(line.quantity) || 0)
  const pct = Math.min(100, Math.max(0, Number(line.discountPct) || 0))
  const add = Math.max(0, Number(line.addDisc) || 0)
  return round2(Math.min(gross, (gross * pct) / 100 + add))
}

export const lineNet = (line) =>
  round2((Number(line.price) || 0) * (Number(line.quantity) || 0) - lineDiscount(line))

/** What the strip shows before, or without, a server quote. */
export const localTotals = (lines) =>
  lines.reduce(
    (acc, line) => {
      const qty = Number(line.quantity) || 0
      acc.quantity += qty
      acc.mrp += (Number(line.mrp) || Number(line.price) || 0) * qty
      acc.gross += (Number(line.price) || 0) * qty
      acc.lineDiscount += lineDiscount(line)
      return acc
    },
    { quantity: 0, mrp: 0, gross: 0, lineDiscount: 0 },
  )

/** A cart line from a menu item. Codes are what a scanner types, so they are kept. */
export const lineFromItem = (item) => ({
  key: `${item.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  itemId: String(item.id),
  name: item.name,
  itemCode: item.itemCode || item.sku || item.barcode || "",
  barcode: item.barcode || "",
  price: Number(item.price) || 0,
  mrp: item.mrp != null ? Number(item.mrp) : null,
  unit: item.packSize || item.unit || "",
  gstRate: item.gstRate ?? null,
  stockQty: item.stockQty ?? null,
  quantity: 1,
  discountPct: 0,
  addDisc: 0,
})

/** Does a typed or scanned string name this item exactly? Codes first, then the name. */
export const matchesCode = (item, code) => {
  const c = String(code || "").trim().toLowerCase()
  if (!c) return false
  return [item.barcode, item.sku, item.itemCode].some((v) => v && String(v).trim().toLowerCase() === c)
}

/**
 * The product a scanned code names: an exact barcode / SKU / item-code match, preferring
 * one that can be sold when several share the code. Null when nothing matches.
 */
export const findItemByCode = (items, code) => {
  const hits = (items || []).filter((it) => matchesCode(it, code))
  return hits.find((it) => it.isAvailable !== false) || hits[0] || null
}

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch])

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]

const twoDigits = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`)

/** Indian grouping — crore, lakh, thousand — not the short scale. */
const threeAndUp = (n) => {
  const parts = []
  const crore = Math.floor(n / 10000000)
  const lakh = Math.floor((n % 10000000) / 100000)
  const thousand = Math.floor((n % 100000) / 1000)
  const hundred = Math.floor((n % 1000) / 100)
  const rest = n % 100

  if (crore) parts.push(`${threeAndUp(crore)} Crore`)
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`)
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`)
  if (hundred) parts.push(`${ONES[hundred]} Hundred`)
  // "and" only where a hundred is followed by a remainder, which is how the
  // amount is read aloud and how every printed bill in the country writes it.
  if (rest) parts.push(`${hundred ? "and " : ""}${twoDigits(rest)}`)
  return parts.join(" ")
}

/** "Rupees Nine Hundred and Forty Six Only" — required on a tax invoice. */
export const amountInWords = (value) => {
  const total = Math.max(0, Number(value) || 0)
  const rupees = Math.floor(total)
  const paise = Math.round((total - rupees) * 100)
  if (!rupees && !paise) return "Rupees Zero Only"
  const head = rupees ? `Rupees ${threeAndUp(rupees)}` : "Rupees Zero"
  // Comma, not a second "and": the rupee words may already contain one
  // ("Two Hundred and Eight"), and "and Eight and Fifty Paise" reads as a sum.
  return paise ? `${head}, Paise ${twoDigits(paise)} Only` : `${head} Only`
}

/**
 * An 80mm receipt. Opened in its own window and printed from there, the same
 * way the customer-side invoice does it, so the till's own layout never has
 * to carry print CSS.
 */
const pad2 = (n) => String(n).padStart(2, "0")
const billDate = (d) => { const x = new Date(d); return `${pad2(x.getDate())}/${pad2(x.getMonth() + 1)}/${x.getFullYear()}` }
const billTime = (d) => new Date(d).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true })

/**
 * The printed bill: a tax invoice on 80mm paper.
 *
 * It carries what a GST invoice has to — the seller's GSTIN, the place of
 * supply, and a CGST/SGST summary per slab — plus what the counter needs:
 * tendered and change, so the drawer can be reconciled against the paper, and
 * a scannable bill number so a reprint does not mean retyping it.
 *
 * A held bill goes through the same layout but is stamped as not a tax
 * invoice, because nothing has been charged for it yet.
 */
export const receiptHtml = (r, { title = "Invoice", held = false } = {}) => {
  const store = r.store || {}
  const p = r.pricing || {}
  const pay = r.payment || {}
  const when = r.createdAt || new Date()

  const rows = (r.items || [])
    .map(
      (it, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(it.name)}${it.variantName ? ` <small>(${escapeHtml(it.variantName)})</small>` : ""}
          ${it.gstRate ? `<div class="hsn">GST ${it.gstRate}%</div>` : ""}</td>
        <td class="r">${Number(it.quantity).toFixed(3)}</td>
        <td class="r">${money(it.price, 2)}</td>
        <td class="r">${money(it.discount || 0, 2)}</td>
        <td class="r">${money(it.amount, 2)}</td>
      </tr>${
        // The item's own barcode, under its line: scanning it at the counter looks the product
        // up again, which is how a return or an exchange is rung up without typing a name.
        it.barcode
          ? `<tr><td></td><td colspan="5" class="ibc">${barcodeSvg(it.barcode, { height: 16, module: 1 })}<span class="hsn">${escapeHtml(it.barcode)}</span></td></tr>`
          : ""
      }`,
    )
    .join("")

  const taxRows = (r.taxSummary || [])
    .map(
      (t) => `<tr>
        <td class="r">${money(t.taxableValue, 2)}</td>
        <td class="r">${money(t.cgst, 2)}</td>
        <td class="r">${money(t.sgst, 2)}</td>
        <td class="r">${money(t.cess, 2)}</td>
        <td class="r">${money(t.igst, 2)}</td>
      </tr>`,
    )
    .join("")

  // One line per tender, so a split bill shows how it was actually settled.
  const tenderLines = (pay.tenders || [])
    .map((t) => {
      const head = `<tr><td>BY ${escapeHtml(String(TENDER_LABEL[t.mode] || t.mode).toUpperCase())}</td><td class="sep">:</td><td class="r">${money(t.amount, 2)}</td></tr>`
      // The card reference belongs on the customer's copy: it is what they
      // quote back when they dispute the charge.
      const ref = [t.cardHolder, t.transactionNo && `Txn ${t.transactionNo}`, t.customerBank]
        .filter(Boolean)
        .map(escapeHtml)
        .join(" · ")
      return ref ? `${head}<tr><td colspan="3" class="hsn">${ref}</td></tr>` : head
    })
    .join("")

  const line = (label, value, bold = false) =>
    `<tr${bold ? ' class="b"' : ""}><td>${label}</td><td class="sep">:</td><td class="r">${value}</td></tr>`

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} ${escapeHtml(r.billNo || "")}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 11px/1.3 "Courier New", monospace; color: #000; margin: 0; padding: 6px; width: 80mm; }
  h1 { font-size: 14px; margin: 0 0 1px; text-align: center; text-transform: uppercase; }
  .c { text-align: center; } .r { text-align: right; } .b { font-weight: bold; }
  .muted { font-size: 10px; }
  .hsn { font-size: 9px; }
  .ibc svg { display: block; height: 16px; width: auto; max-width: 100%; }
  hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 1px 0; vertical-align: top; }
  .items th { border-bottom: 1px solid #000; border-top: 1px solid #000; text-align: left; font-size: 10px; }
  .items th.r, .items td.r { text-align: right; }
  .sep { width: 10px; text-align: center; }
  .grand td { font-size: 13px; font-weight: bold; }
  .tax th, .tax td { border: 1px solid #000; padding: 1px 2px; font-size: 9px; text-align: right; }
  .stamp { display: inline-block; border: 1px solid #000; padding: 0 4px; font-size: 10px; font-weight: bold; }
  .foot { display: flex; justify-content: space-between; font-size: 9px; }
  /* The watermark sits behind the figures and prints: a slip that looks like a
     bill but is not one has to say so at a glance, not in small print that the
     eye skips. -webkit-print-color-adjust keeps Chrome from dropping it. */
  .mark { position: fixed; top: 42%; left: 50%; transform: translate(-50%, -50%) rotate(-32deg);
    font-size: 46px; font-weight: bold; color: #e11d48; opacity: .35; white-space: nowrap;
    pointer-events: none; z-index: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body > *:not(.mark) { position: relative; z-index: 1; }
  @media print { body { width: auto; padding: 0; } }
</style></head><body>
  ${held ? '<div class="mark">Hold Bill</div>' : ""}
  <div class="c b" style="font-size:12px">${held ? "HOLD BILL" : escapeHtml(title.toUpperCase())}</div>
  <h1>${escapeHtml(store.name || "")}</h1>
  ${store.address ? `<div class="c muted">${escapeHtml(store.address)}</div>` : ""}
  ${store.gstNumber ? `<div class="c muted">GSTIN NO : ${escapeHtml(store.gstNumber)}</div>` : ""}
  ${store.fssaiNumber ? `<div class="c muted">FSSAI : ${escapeHtml(store.fssaiNumber)}</div>` : ""}
  ${store.phone ? `<div class="c muted">Phone No : ${escapeHtml(store.phone)}</div>` : ""}
  <hr>

  <table class="muted">
    <tr>
      <td>Name</td><td class="sep">:</td><td>${escapeHtml(r.customer?.name || "Walk in Customer")}</td>
      <td>Date</td><td class="sep">:</td><td class="r">${billDate(when)}</td>
    </tr>
    <tr>
      <td>Mobile</td><td class="sep">:</td><td>${escapeHtml(r.customer?.phone || "-")}</td>
      <td>Time</td><td class="sep">:</td><td class="r">${billTime(when)}</td>
    </tr>
    <tr>
      <td>${held ? "Hold Bill" : "Invoice No"}</td><td class="sep">:</td><td><b>${escapeHtml(r.billNo || "-")}</b></td>
      <td>Cashier</td><td class="sep">:</td><td class="r">${escapeHtml(r.salesman || "-")}</td>
    </tr>
    <tr>
      <td>Type</td><td class="sep">:</td>
      <td colspan="4">${escapeHtml(r.orderTypeLabel || ORDER_TYPE_LABEL[r.orderType] || "")}${r.tableNo ? ` · Table ${escapeHtml(r.tableNo)}` : ""}</td>
    </tr>
  </table>

  <table class="items" style="margin-top:4px">
    <thead><tr><th>#</th><th>Item</th><th class="r">Qty</th><th class="r">MRP</th><th class="r">Disc</th><th class="r">Net</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <table style="margin-top:4px">
    ${line("SUB TOTAL", money(p.subtotal, 2))}
    ${p.discount ? line(`DISCOUNT${p.couponCode ? ` (${escapeHtml(p.couponCode)})` : ""}`, `-${money(p.discount, 2)}`) : ""}
    ${p.tax ? line("GST", money(p.tax, 2)) : ""}
    ${p.additionalCharges ? line("ADD. CHARGES", money(p.additionalCharges, 2)) : ""}
    ${line("ROUND OFF", `${p.roundOff > 0 ? "+" : ""}${money(p.roundOff || 0, 2)}`)}
    <tr class="grand"><td>TOTAL</td><td class="sep">:</td><td class="r">${money(p.total, 2)}</td></tr>
    ${held ? "" : tenderLines}
  </table>
  <hr>

  <table class="muted">
    ${held
      ? `${line("PIECES PURCHASED", Number(r.totalQuantity || 0).toFixed(0))}
         ${line("DISCOUNT ITEMS", Number(r.discountedLines || 0).toFixed(0))}
         ${line("TOTAL DISCOUNT", money(p.discount || 0, 2))}`
      : `${line("NO OF QTY", Number(r.totalQuantity || 0).toFixed(3))}
         ${line("TENDERED", money(pay.tendered || 0, 2))}
         ${line("CHANGE", money(pay.changeGiven || 0, 2))}
         ${pay.dueAmount ? line("BALANCE DUE", money(pay.dueAmount, 2), true) : ""}`}
  </table>
  <hr>

  ${held ? "" : `<div class="muted b">${escapeHtml(amountInWords(p.total))}</div>`}
  ${store.state ? `<div class="muted">Place of Supply : ${escapeHtml(store.state)}</div>` : ""}

  ${taxRows
      ? `<div class="c b" style="margin-top:4px;font-size:10px">TAX SUMMARY</div>
  <table class="tax">
    <thead><tr><th>TAXABLE VALUE</th><th>CGST</th><th>SGST</th><th>Cess</th><th>IGST</th></tr></thead>
    <tbody>${taxRows}</tbody>
  </table>`
      : ""}

  ${r.remarks ? `<div class="muted" style="margin-top:4px">Remarks : ${escapeHtml(r.remarks)}</div>` : ""}

  ${held
      ? `<div class="muted b" style="margin-top:4px">T &amp; C</div>
         <div class="hsn">Not a tax invoice. Nothing has been charged — this bill is parked and prices are confirmed when it is paid.</div>`
      // No barcode on a held bill: the "Scan Sales Invoice" box looks up sales,
      // and a scannable code on a slip that is not one invites the mistake.
      : `<div class="c" style="margin-top:6px">${barcodeSvg(r.billNo)}</div>`}
  <div class="c muted">Thank you for shopping${store.name ? ` at ${escapeHtml(store.name)}` : " with us"}</div>
  <hr>
  <div class="foot"><span>Printed On : ${billDate(new Date())} ${billTime(new Date())}</span><span>E&amp;OE</span></div>
  <script>window.onload = function () { window.print(); };</script>
</body></html>`
}

export const printReceipt = (receipt, opts) => {
  if (!receipt) return false
  const w = window.open("", "_blank", "width=420,height=640")
  if (!w) return false
  w.document.open()
  w.document.write(receiptHtml(receipt, opts))
  w.document.close()
  return true
}
