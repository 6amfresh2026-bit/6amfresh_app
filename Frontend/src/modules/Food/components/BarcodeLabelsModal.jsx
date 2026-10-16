import { useMemo, useState } from "react"
import PosModal, { btnDark, btnLight, inputCls } from "./restaurant/pos/PosModal"
import { LABEL_SIZES, openLabelWindow, printLabels } from "@food/utils/barcode"

/**
 * Pick products, say how many labels of each, print.
 *
 * A product with no barcode gets one at print time: `assignBarcodes(ids)` asks the
 * server to generate and save a barcode for each product that lacks one and returns
 * every selected product's barcode. So a label that comes out of the printer is always
 * one the till can scan, and the product keeps the barcode afterwards.
 *
 * Used by the seller's inventory and the admin's product list; they differ only in the
 * endpoint behind `assignBarcodes`.
 *
 * items:            [{ id, name, price, mrp, barcode, itemCode, unit }]
 * assignBarcodes:   (ids) => Promise<[{ id, barcode, generated }]>
 * onAssigned:       (rows) => void, so the page can show the new barcodes
 * initialSelected:  ids ticked when the dialog opens
 */
const errorText = (err) => err?.response?.data?.message || err?.message || "Could not prepare the labels"

export default function BarcodeLabelsModal({ items, assignBarcodes, onAssigned, onClose, storeName = "", initialSelected = [] }) {
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(() => new Set(initialSelected.map(String)))
  const [copies, setCopies] = useState({})
  const [sizeId, setSizeId] = useState(LABEL_SIZES[0].id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return items
    return items.filter((it) => [it.name, it.barcode, it.itemCode].some((v) => String(v || "").toLowerCase().includes(needle)))
  }, [items, query])

  const chosen = useMemo(() => items.filter((it) => selected.has(String(it.id))), [items, selected])
  const needNew = chosen.filter((it) => !it.barcode).length
  const allVisibleChosen = visible.length > 0 && visible.every((it) => selected.has(String(it.id)))

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev)
      const key = String(id)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const toggleVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const it of visible) {
        if (allVisibleChosen) next.delete(String(it.id))
        else next.add(String(it.id))
      }
      return next
    })

  const copiesOf = (id) => Math.min(Math.max(parseInt(copies[id], 10) || 1, 1), 500)

  const print = async () => {
    if (!chosen.length || busy) return
    setError("")
    setBusy(true)
    // Opened now, filled after the barcodes come back: a popup opened after the wait is blocked.
    const win = openLabelWindow()
    if (!win) {
      setBusy(false)
      setError("Your browser blocked the print window. Allow pop-ups for this site and try again.")
      return
    }
    try {
      const rows = await assignBarcodes(chosen.map((it) => String(it.id)))
      const codes = new Map(rows.map((r) => [String(r.id), r.barcode]))
      if (rows.some((r) => r.generated)) onAssigned?.(rows.filter((r) => r.generated))

      const size = LABEL_SIZES.find((s) => s.id === sizeId) || LABEL_SIZES[0]
      const labels = chosen.map((it) => ({
        name: it.name,
        barcode: codes.get(String(it.id)) || it.barcode || "",
        price: it.price,
        mrp: it.mrp,
        unit: it.unit,
        copies: copiesOf(it.id),
      }))
      if (!labels.some((l) => l.barcode)) throw new Error("None of the chosen products could be given a barcode")
      printLabels(labels, { widthMm: size.widthMm, heightMm: size.heightMm, storeName }, win)
    } catch (err) {
      win.close()
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <PosModal
      title="Print barcode labels"
      onClose={onClose}
      width="max-w-3xl"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-gray-600" aria-live="polite">
            {chosen.length} selected
            {needNew ? <span className="ml-2 text-amber-700">{needNew} will get a new barcode</span> : null}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={sizeId}
              onChange={(e) => setSizeId(e.target.value)}
              className="h-9 rounded border border-gray-300 bg-white px-2 text-sm"
              aria-label="Label size"
            >
              {LABEL_SIZES.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            <button type="button" className={btnLight} onClick={onClose}>Cancel</button>
            <button type="button" className={btnDark} onClick={print} disabled={!chosen.length || busy}>
              {busy ? "Preparing…" : "Print labels"}
            </button>
          </div>
        </div>
      }
    >
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name or barcode"
        className={`${inputCls} mb-3`}
        autoFocus
      />
      {error ? <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p> : null}

      <div className="max-h-[50vh] overflow-auto rounded border border-gray-200">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="w-10 px-3 py-2">
                <input type="checkbox" checked={allVisibleChosen} onChange={toggleVisible} aria-label="Select all shown" />
              </th>
              <th className="px-2 py-2">Product</th>
              <th className="px-2 py-2">Barcode</th>
              <th className="w-20 px-2 py-2 text-right">Labels</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-8 text-center text-gray-400">No products match</td></tr>
            ) : (
              visible.map((it) => {
                const on = selected.has(String(it.id))
                return (
                  <tr key={it.id} className={`border-t border-gray-100 ${on ? "bg-sky-50" : ""}`}>
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={on} onChange={() => toggle(it.id)} aria-label={`Select ${it.name}`} />
                    </td>
                    <td className="px-2 py-2 text-gray-800">{it.name}</td>
                    <td className="px-2 py-2 font-mono text-xs text-gray-600">
                      {it.barcode || <span className="font-sans text-amber-700">none yet, will be generated</span>}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={copies[it.id] ?? 1}
                        onChange={(e) => setCopies((prev) => ({ ...prev, [it.id]: e.target.value }))}
                        disabled={!on}
                        className="w-16 rounded border border-gray-300 px-1.5 py-1 text-right text-sm disabled:opacity-40"
                        aria-label={`Labels for ${it.name}`}
                      />
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </PosModal>
  )
}
