import { encodeBars } from "./barcode"
import { paginate, pageGeometry } from "./labelLayout"

/**
 * The labels as a PDF: the same pages as the browser print, but with the real barcode drawn as
 * vector bars, so it prints sharp at any size and does not depend on the browser's print dialog.
 *
 * jsPDF's built-in fonts hold Latin text only. The rupee sign is written "Rs" and any other
 * character outside Latin-1 becomes "?" rather than a garbled glyph; the barcode itself carries
 * the product's identity, so a name that does not fit the font never makes a label unscannable.
 */
const pdfText = (s) => String(s ?? "").replace(/₹/g, "Rs ").replace(/[^\x20-\xff]/g, "?")

const PAD = 1.6 // mm of white space inside each label

/** Cuts `text` to fit `maxWidth` at the current font, ending in "..." when it had to. */
const fit = (doc, text, maxWidth) => {
  if (doc.getTextWidth(text) <= maxWidth) return text
  let t = text
  while (t.length > 1 && doc.getTextWidth(`${t}...`) > maxWidth) t = t.slice(0, -1)
  return `${t}...`
}

/** Draws one label with its top-left corner at (x, y), `w` by `h` mm. */
export const drawLabel = (doc, label, x, y, w, h) => {
  const small = h < 26
  const pad = small ? 1.1 : PAD
  const innerW = w - pad * 2
  const nameSize = small ? 6.5 : 8.5
  const priceSize = small ? 8 : 11
  const metaSize = small ? 5.5 : 7
  const hcSize = small ? 6 : 8
  const dateSize = small ? 5 : 6.5

  doc.setTextColor(0, 0, 0)

  // Row 1: name left, price right.
  const priceText = pdfText(label.priceText)
  let priceW = 0
  if (priceText) {
    doc.setFont("helvetica", "bold")
    doc.setFontSize(priceSize)
    priceW = doc.getTextWidth(priceText)
    doc.text(priceText, x + w - pad, y + pad + nameSize * 0.3528 * 0.85, { align: "right" })
  }
  doc.setFont("helvetica", "bold")
  doc.setFontSize(nameSize)
  const nameY = y + pad + nameSize * 0.3528 * 0.85
  doc.text(fit(doc, pdfText(label.name), innerW - priceW - (priceW ? 2 : 0)), x + pad, nameY)

  // Row 2: pack size, then MRP (struck through when it is the "was" price).
  const metaY = nameY + metaSize * 0.3528 + 1.3
  doc.setFont("helvetica", "normal")
  doc.setFontSize(metaSize)
  let cursor = x + pad
  const unit = pdfText(label.unit)
  if (unit) {
    doc.text(unit, cursor, metaY)
    cursor += doc.getTextWidth(unit)
  }
  const mrp = pdfText(label.mrpText)
  if (mrp) {
    if (unit) {
      doc.text(" · ", cursor, metaY)
      cursor += doc.getTextWidth(" · ")
    }
    doc.text(mrp, cursor, metaY)
    if (label.mrpStruck) {
      const mw = doc.getTextWidth(mrp)
      doc.setLineWidth(0.18)
      doc.setLineDashPattern([], 0)
      doc.line(cursor, metaY - metaSize * 0.3528 * 0.3, cursor + mw, metaY - metaSize * 0.3528 * 0.3)
    }
  }

  // Bottom: optional dates, then the digits, then (above them) the bars take what is left.
  const hasDates = Boolean(label.packed || label.expiry)
  let floor = y + h - pad
  if (hasDates) {
    doc.setFont("helvetica", "normal")
    doc.setFontSize(dateSize)
    if (label.packed) doc.text(`Packed: ${label.packed}`, x + pad, floor)
    if (label.expiry) doc.text(`Exp: ${label.expiry}`, x + w - pad, floor, { align: "right" })
    floor -= dateSize * 0.3528 + 0.8
  }
  doc.setFont("courier", "normal")
  doc.setFontSize(hcSize)
  doc.text(pdfText(label.human), x + w / 2, floor, { align: "center", charSpace: 0.35 })

  const barTop = metaY + 1.4
  const barBottom = floor - hcSize * 0.3528 - 0.6
  const barH = Math.max(4, barBottom - barTop)

  const encoded = encodeBars(label.barcode)
  if (!encoded) return
  const quiet = 10 // modules of white either side, as in the on-screen barcode
  const scale = innerW / (encoded.width + quiet * 2)
  doc.setFillColor(0, 0, 0)
  for (const bar of encoded.bars) {
    doc.rect(x + pad + (quiet + bar.x) * scale, barTop, bar.w * scale, barH, "F")
  }
}

/**
 * Builds the PDF for a flat list of labels (see expandCopies) in a layout. Returns the jsPDF
 * document; call `.save(name)` or `.output("bloburl")` on it. jsPDF is loaded only when asked for.
 */
export const buildLabelsPdf = async (flat, layout, { guides = false, compress = true } = {}) => {
  const { jsPDF } = await import("jspdf")
  const g = pageGeometry(layout)
  const doc = new jsPDF({
    unit: "mm",
    format: [g.pageWidthMm, g.pageHeightMm],
    orientation: g.pageWidthMm > g.pageHeightMm ? "landscape" : "portrait",
    compress,
  })

  const pages = paginate(flat, layout)
  pages.forEach((page, pageIndex) => {
    if (pageIndex > 0) doc.addPage([g.pageWidthMm, g.pageHeightMm], g.pageWidthMm > g.pageHeightMm ? "landscape" : "portrait")
    page.forEach((label, i) => {
      const col = layout.kind === "sheet" ? i % layout.cols : 0
      const row = layout.kind === "sheet" ? Math.floor(i / layout.cols) : 0
      const x = g.marginXMm + col * layout.widthMm
      const y = g.marginYMm + row * layout.heightMm
      if (guides) {
        doc.setDrawColor(156, 163, 175)
        doc.setLineWidth(0.2)
        doc.setLineDashPattern([1, 1], 0)
        doc.rect(x, y, layout.widthMm, layout.heightMm)
        doc.setLineDashPattern([], 0)
      }
      drawLabel(doc, label, x, y, layout.widthMm, layout.heightMm)
    })
  })

  return doc
}
