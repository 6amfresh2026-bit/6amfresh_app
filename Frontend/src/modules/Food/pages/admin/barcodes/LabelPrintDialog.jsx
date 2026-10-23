import { useEffect, useMemo, useState } from "react"
import { Download, Loader2, Printer, Tag } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@food/components/ui/dialog"
import {
  DEFAULT_OPTIONS,
  LABEL_CSS,
  LABEL_LAYOUTS,
  buildLabel,
  expandCopies,
  getLayout,
  labelHtml,
  labelSheetHtml,
  paginate,
} from "@food/utils/labelLayout"

/**
 * Print barcode labels: how the sheet is laid out, which price to show, what to print on each
 * label, and how many of each, with a preview of the first label.
 *
 * `rows` are the barcode rows chosen on the page ({ id, name, unit, barcode, price, mrp,
 * expiryDate }). "Print" opens the browser's print dialog on the sheet; "Download PDF" saves the
 * same pages with the real barcode drawn as vector bars. A product with no barcode is left out,
 * and the dialog says so.
 */

const CHIPS = [
  { key: "showPrice", label: "Selling price" },
  { key: "showMrp", label: "MRP (struck)" },
  { key: "packed", label: "Packed date" },
  { key: "expiry", label: "Expiry date" },
  { key: "guides", label: "Cut guide lines" },
]

const norm = (s) => String(s || "").trim().toLowerCase()

export default function LabelPrintDialog({ rows, onClose }) {
  const [layoutId, setLayoutId] = useState(LABEL_LAYOUTS[0].id)
  const [opts, setOpts] = useState(DEFAULT_OPTIONS)
  const [copies, setCopies] = useState({})
  const [stores, setStores] = useState([])
  const [storeId, setStoreId] = useState("") // "" = each product's own price
  const [storePrices, setStorePrices] = useState({}) // rowId -> { price, mrp } | null (not sold there)
  const [pricing, setPricing] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)

  const layout = getLayout(layoutId)

  // The stores for "Price for store".
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await adminAPI.getRestaurants({ limit: 1000 })
        const list = res?.data?.data?.restaurants || res?.data?.restaurants || []
        if (cancelled) return
        setStores(
          (Array.isArray(list) ? list : [])
            .map((r) => ({ id: String(r._id || r.id || ""), name: r.restaurantName || r.name || "Store" }))
            .filter((s) => s.id),
        )
      } catch {
        /* the dropdown keeps just "each product's own price" */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Each product is stored once per store, with that store's own price. Choosing a store looks
  // the same product up there (same name and pack size) and uses its price and MRP.
  useEffect(() => {
    if (!storeId) {
      setStorePrices({})
      return undefined
    }
    let cancelled = false
    setPricing(true)
    ;(async () => {
      const found = {}
      await Promise.all(
        rows.map(async (row) => {
          try {
            const res = await adminAPI.getBarcodes({ restaurantId: storeId, search: row.name, limit: 50 })
            const items = res?.data?.data?.items || []
            const match = items.find((it) => norm(it.name) === norm(row.name) && norm(it.unit) === norm(row.unit))
            found[row.id] = match ? { price: match.price, mrp: match.mrp } : null
          } catch {
            found[row.id] = null
          }
        }),
      )
      if (cancelled) return
      setStorePrices(found)
      setPricing(false)
    })()
    return () => {
      cancelled = true
    }
  }, [storeId, rows])

  const labels = useMemo(
    () =>
      rows
        .map((row) => {
          const own = storeId ? storePrices[row.id] : null
          return buildLabel({ ...row, ...(own || {}), copies: copies[row.id] }, opts)
        })
        .filter(Boolean),
    [rows, copies, opts, storeId, storePrices],
  )
  const skipped = rows.length - labels.length
  const notSold = storeId ? rows.filter((r) => storePrices[r.id] === null).length : 0
  const flat = useMemo(() => expandCopies(labels), [labels])
  const pageCount = useMemo(() => paginate(flat, layout).length, [flat, layout])
  const isSheet = layout.kind === "sheet"

  const toggle = (key) => setOpts((o) => ({ ...o, [key]: !o[key] }))

  const print = () => {
    if (flat.length === 0) return
    // Opened in the click itself, before anything async, or the browser blocks it as a pop-up.
    const win = window.open("", "_blank", "width=900,height=700")
    if (!win) {
      toast.error("Allow pop-ups to print labels")
      return
    }
    win.document.open()
    win.document.write(labelSheetHtml(flat, layout, { guides: opts.guides }))
    win.document.close()
  }

  const downloadPdf = async () => {
    if (flat.length === 0) return
    setPdfBusy(true)
    try {
      const { buildLabelsPdf } = await import("@food/utils/labelPdf")
      const doc = await buildLabelsPdf(flat, layout, { guides: opts.guides })
      doc.save(`barcode-labels-${layout.id}.pdf`)
    } catch (error) {
      toast.error(error?.message || "Could not build the PDF")
    } finally {
      setPdfBusy(false)
    }
  }

  const subtitle = `${labels.length} ${labels.length === 1 ? "product" : "products"} · ${flat.length} ${flat.length === 1 ? "label" : "labels"}${
    isSheet ? ` · ${pageCount} ${pageCount === 1 ? "sheet" : "sheets"}` : ""
  }`

  const previewHtml = labels[0]
    ? `<style>${LABEL_CSS}</style><div style="width:${layout.widthMm}mm;height:${layout.heightMm}mm">${labelHtml(labels[0], layout)}</div>`
    : ""

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto p-5 sm:max-w-3xl sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-neutral-900">
            <Tag className="h-5 w-5 text-primary" /> Print barcode labels
          </DialogTitle>
          <p className="text-sm text-neutral-500" aria-live="polite">{subtitle}</p>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-neutral-500">Label size</span>
              <select
                value={layoutId}
                onChange={(e) => setLayoutId(e.target.value)}
                className="h-11 w-full rounded-xl border border-neutral-300 bg-white px-3 text-neutral-900 outline-none focus:border-primary"
              >
                {LABEL_LAYOUTS.map((l) => (
                  <option key={l.id} value={l.id}>{l.label}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-neutral-500">Price for store</span>
              <select
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
                className="h-11 w-full rounded-xl border border-neutral-300 bg-white px-3 text-neutral-900 outline-none focus:border-primary"
              >
                <option value="">Each product&apos;s own price</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap gap-2" role="group" aria-label="What to print">
            {CHIPS.map((chip) => (
              <label
                key={chip.key}
                className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium ${
                  opts[chip.key] ? "border-primary bg-primary/10 text-neutral-900" : "border-neutral-300 text-neutral-600 hover:border-neutral-400"
                }`}
              >
                <input type="checkbox" checked={Boolean(opts[chip.key])} onChange={() => toggle(chip.key)} className="h-4 w-4 accent-[color:var(--module-theme,#10b981)]" />
                {chip.label}
              </label>
            ))}
          </div>

          {(pricing || notSold > 0 || skipped > 0) && (
            <div className="space-y-1 text-xs">
              {pricing && <p className="flex items-center gap-1.5 text-neutral-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking up prices at that store…</p>}
              {!pricing && notSold > 0 && <p className="text-amber-700">{notSold} {notSold === 1 ? "product is" : "products are"} not sold at this store, so {notSold === 1 ? "it keeps" : "they keep"} their own price.</p>}
              {skipped > 0 && <p className="text-rose-600">{skipped} {skipped === 1 ? "product has" : "products have"} no barcode and will be left out. Generate barcodes first.</p>}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-[auto_1fr]">
            <div className="flex items-start justify-center rounded-xl border border-neutral-200 bg-neutral-100 p-3">
              {previewHtml ? (
                <div className="bg-white shadow-sm outline outline-1 outline-neutral-300" data-testid="label-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
              ) : (
                <div className="flex h-24 w-56 items-center justify-center text-center text-xs text-neutral-400">Nothing to preview</div>
              )}
            </div>

            <div className="max-h-64 overflow-auto rounded-xl border border-neutral-200">
              <table className="w-full text-left">
                <thead className="sticky top-0 bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Product</th>
                    <th className="w-24 px-3 py-2 text-right font-medium">Copies</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-t border-neutral-100">
                      <td className="px-3 py-2">
                        <div className="font-medium text-neutral-900">{row.name}</div>
                        <div className="font-mono text-xs text-neutral-400">{row.barcode || "no barcode"}</div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          min={1}
                          max={500}
                          value={copies[row.id] ?? 1}
                          onChange={(e) => setCopies((c) => ({ ...c, [row.id]: e.target.value }))}
                          disabled={!row.barcode}
                          aria-label={`Copies of ${row.name}`}
                          className="h-9 w-20 rounded-lg border border-neutral-300 bg-white px-2 text-right text-neutral-900 outline-none focus:border-primary disabled:opacity-40"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-xs text-neutral-500">
            {isSheet
              ? 'Print on plain A4 label sheets at 100% scale (turn off "Fit to page") so the labels line up with the cut-outs. The preview is a sketch; the PDF has the true barcode.'
              : "Prints one label per page, sized to the label. Set the printer to 100% scale. The preview is a sketch; the PDF has the true barcode."}
          </p>

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="h-10 rounded-full border border-neutral-300 px-5 font-medium text-neutral-700 hover:bg-neutral-50">Close</button>
            <button type="button" onClick={print} disabled={flat.length === 0 || pricing} className="inline-flex h-10 items-center gap-2 rounded-full border border-neutral-300 px-5 font-medium text-neutral-800 hover:border-primary hover:text-primary disabled:opacity-40">
              <Printer className="h-4 w-4" /> Print
            </button>
            <button type="button" onClick={downloadPdf} disabled={flat.length === 0 || pricing || pdfBusy} className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {pdfBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download PDF
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
