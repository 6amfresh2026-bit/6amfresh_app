import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Loader2, Plus, Barcode as BarcodeIcon, ScanLine, Tag, AlertTriangle, Search, Printer } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@food/components/ui/dialog"
import { barcodeSvg, isValidEan13 } from "@food/utils/barcode"
import LabelPrintDialog from "./LabelPrintDialog"

/**
 * Barcodes & labels — a scannable code for every product, and a label to print.
 *
 * Each row shows the code the product will print with: its saved manufacturer
 * code where it has one, an internal "29"-prefixed EAN-13 otherwise. Generate &
 * save writes those internal codes to the catalogue in one go; the per-row label
 * button and the bulk "Print labels" hand the selected rows to the shared label
 * sheet, which draws the same barcode the screen shows.
 */

const money = (v) => "₹" + Number(v || 0).toFixed(2).replace(/\.00$/, "")
const today = () => new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })

export default function BarcodesLabels() {
  const navigate = useNavigate()
  const [items, setItems] = useState([])
  const [summary, setSummary] = useState({ products: 0, soldByWeight: 0, ownSaved: 0, autoCode: 0, duplicates: 0 })
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)

  const [search, setSearch] = useState("")
  const [debounced, setDebounced] = useState("")
  const [categoryId, setCategoryId] = useState("")
  const [filter, setFilter] = useState("") // "", "missing", "saved"
  const [labelRows, setLabelRows] = useState(null) // products handed to the print dialog

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)

  const [selected, setSelected] = useState(() => new Set())
  const [editRow, setEditRow] = useState(null)

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 300)
    return () => clearTimeout(id)
  }, [search])

  useEffect(() => {
    ;(async () => {
      try {
        const c = await adminAPI.getCategories({ limit: 1000 })
        const list = c?.data?.data?.categories || c?.data?.data || []
        setCategories(Array.isArray(list) ? list : [])
      } catch {
        /* category filter degrades to all */
      }
    })()
  }, [])

  const fetchItems = useCallback(async () => {
    setLoading(true)
    try {
      const params = { page, limit: pageSize }
      if (debounced) params.search = debounced
      if (categoryId) params.categoryId = categoryId
      if (filter) params.filter = filter
      const res = await adminAPI.getBarcodes(params)
      const d = res?.data?.data || {}
      setItems(d.items || [])
      setTotal(Number(d.total) || 0)
      setSummary(d.summary || { products: 0, soldByWeight: 0, ownSaved: 0, autoCode: 0, duplicates: 0 })
      setSelected(new Set())
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to load barcodes")
    } finally {
      setLoading(false)
    }
  }, [debounced, categoryId, filter, page, pageSize])

  // Filters and search reset to the first page so results are not hidden on a
  // page that no longer exists after the set shrinks.
  useEffect(() => {
    setPage(1)
  }, [debounced, categoryId, filter, pageSize])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  const toggle = (id) =>
    setSelected((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  const selectAllShown = () => setSelected(new Set(items.map((i) => i.id)))
  const clearSelection = () => setSelected(new Set())

  const generateAll = async () => {
    setGenerating(true)
    try {
      const res = await adminAPI.saveBarcodes({})
      toast.success(`Saved ${res?.data?.data?.saved ?? 0} barcodes`)
      fetchItems()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not save barcodes")
    } finally {
      setGenerating(false)
    }
  }

  // Both the bulk button and a row's printer icon open the same dialog, which owns the label
  // size, the price, what is printed on each label and the copies.
  const printSelected = () => {
    const rows = items.filter((i) => selected.has(i.id))
    if (rows.length === 0) return toast.info("Select some products first")
    setLabelRows(rows)
  }

  const printOne = (row) => setLabelRows([row])

  const allShownSelected = items.length > 0 && items.every((i) => selected.has(i.id))
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1
  const lastRow = Math.min(page * pageSize, total)

  const KPIS = [
    { Icon: Tag, tint: "text-primary", label: "Products", value: summary.products, sub: `${summary.soldByWeight} sold by weight` },
    { Icon: BarcodeIcon, tint: "text-primary", label: "Own barcode saved", value: summary.ownSaved, sub: "manufacturer or generated" },
    { Icon: ScanLine, tint: "text-amber-500", label: "Using auto code", value: summary.autoCode, sub: "works, but not saved yet" },
    { Icon: AlertTriangle, tint: summary.duplicates > 0 ? "text-rose-500" : "text-neutral-400", label: "Duplicate codes", value: summary.duplicates, sub: summary.duplicates > 0 ? "need a look" : "none" },
  ]

  return (
    <div className="min-h-screen bg-neutral-50 p-4 text-neutral-700 md:p-6">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900">Barcodes &amp; labels</h1>
          <p className="mt-1 text-sm text-neutral-500">Generate, scan and print barcodes for every product · {today()}</p>
        </div>
        <button
          onClick={() => navigate("/admin/store/products/new")}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> New product
        </button>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {KPIS.map((k) => (
          <div key={k.label} className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-2 text-xs font-medium text-neutral-500">
              <k.Icon className={`h-4 w-4 ${k.tint}`} /> {k.label}
            </div>
            <div className="mt-2 text-3xl font-bold text-neutral-900">{k.value}</div>
            <div className="mt-0.5 text-xs text-neutral-400">{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[260px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Scan a barcode to find a product, or search by name / SKU"
            className="h-10 w-full rounded-lg border border-neutral-300 bg-white pl-9 pr-3 text-sm text-neutral-900 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="h-10 rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-800 outline-none focus:border-primary">
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c._id || c.id} value={c._id || c.id}>{c.name}</option>
          ))}
        </select>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className="h-10 rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-800 outline-none focus:border-primary">
          <option value="">All products</option>
          <option value="missing">Needs a saved code</option>
          <option value="saved">Has a saved code</option>
        </select>
      </div>

      {/* Action bar */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={generateAll}
          disabled={generating || summary.autoCode === 0}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-50"
        >
          {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarcodeIcon className="h-4 w-4" />}
          Generate &amp; save barcodes for {summary.autoCode} products
        </button>
        <button onClick={printSelected} className="inline-flex h-10 items-center gap-2 rounded-full border border-neutral-300 px-4 text-sm font-medium text-neutral-700 hover:border-primary hover:text-primary">
          <Printer className="h-4 w-4" /> Print labels for {selected.size} selected
        </button>
        <button onClick={allShownSelected ? clearSelection : selectAllShown} className="inline-flex h-10 items-center rounded-full border border-neutral-300 px-4 text-sm font-medium text-neutral-700 hover:border-primary hover:text-primary">
          {allShownSelected ? "Unselect all" : `Select all shown (${items.length})`}
        </button>
        <button onClick={clearSelection} className="inline-flex h-10 items-center rounded-full border border-neutral-300 px-4 text-sm font-medium text-neutral-700 hover:border-primary hover:text-primary">
          Clear
        </button>
        <span className="ml-auto text-xs text-neutral-400">Internal codes are EAN-13 starting with 29 (reserved by GS1 for in-store use).</span>
      </div>

      {/* Table */}
      <div className="mt-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-5">
        <h2 className="text-lg font-bold text-neutral-900">Products</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Scan a manufacturer&apos;s barcode into <b className="text-neutral-700">Edit</b> to use it, or generate an internal one and print your own label.
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="w-8 py-3 pr-2">
                  <input type="checkbox" checked={allShownSelected} onChange={allShownSelected ? clearSelection : selectAllShown} className="h-4 w-4 accent-[color:var(--module-theme,#10b981)]" />
                </th>
                <th className="py-3 pr-4 font-medium">Product</th>
                <th className="py-3 pr-4 font-medium">SKU</th>
                <th className="py-3 pr-4 font-medium">Barcode</th>
                <th className="py-3 pr-4 font-medium">Type</th>
                <th className="py-3 pr-4 font-medium">Price</th>
                <th className="py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="py-14 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-neutral-300" /></td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={7} className="py-14 text-center text-neutral-500">No products found.</td></tr>
              ) : (
                items.map((row) => (
                  <tr key={row.id} className="border-b border-neutral-100 align-middle hover:bg-neutral-50">
                    <td className="py-3 pr-2">
                      <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} className="h-4 w-4 accent-[color:var(--module-theme,#10b981)]" />
                    </td>
                    <td className="py-3 pr-4">
                      <div className="font-semibold text-neutral-900">{row.name}</div>
                      <div className="text-xs text-neutral-400">{row.unit || row.categoryName || "—"}</div>
                    </td>
                    <td className="py-3 pr-4 font-mono text-xs text-neutral-600">{row.sku || "—"}</td>
                    <td className="py-3 pr-4">
                      <div className="flex h-[52px] items-center" dangerouslySetInnerHTML={{ __html: barcodeSvg(row.barcode, { height: 36, module: 1.3, showText: true }) }} />
                    </td>
                    <td className="py-3 pr-4">
                      <span className="inline-block rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700">{row.format}</span>
                      <div className="text-[11px] text-neutral-400">{row.source === "saved" ? "saved" : "auto"}</div>
                    </td>
                    <td className="py-3 pr-4 font-semibold text-neutral-800">{row.price == null ? "—" : money(row.price)}</td>
                    <td className="py-3">
                      <div className="flex gap-1.5">
                        <button onClick={() => setEditRow(row)} className="rounded-full border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:border-primary hover:text-primary">Edit</button>
                        <button onClick={() => printOne(row)} title="Print label" className="inline-flex items-center justify-center rounded-full border border-neutral-300 px-2.5 py-1 text-neutral-600 hover:border-primary hover:text-primary">
                          <Printer className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {!loading && total > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 pt-3 text-sm">
            <span className="text-neutral-500">
              Showing <b className="text-neutral-700">{firstRow}</b>–<b className="text-neutral-700">{lastRow}</b> of{" "}
              <b className="text-neutral-700">{total}</b>
            </span>
            <div className="flex items-center gap-2">
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className="h-9 rounded-lg border border-neutral-300 bg-white px-2 text-sm text-neutral-700 outline-none focus:border-primary"
              >
                {[20, 50, 100, 200].map((n) => (
                  <option key={n} value={n}>{n} / page</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="h-9 rounded-lg border border-neutral-300 px-3 font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
              >
                Prev
              </button>
              <span className="min-w-[90px] text-center text-neutral-600">Page {page} of {totalPages}</span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="h-9 rounded-lg border border-neutral-300 px-3 font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {labelRows && <LabelPrintDialog rows={labelRows} onClose={() => setLabelRows(null)} />}

      {editRow && (
        <EditBarcodeModal
          row={editRow}
          onClose={() => setEditRow(null)}
          onSaved={() => { setEditRow(null); fetchItems() }}
        />
      )}
    </div>
  )
}

/** Scan or type a manufacturer code for one product (or clear it back to auto). */
function EditBarcodeModal({ row, onClose, onSaved }) {
  const [value, setValue] = useState(row.source === "saved" ? row.barcode : "")
  const [saving, setSaving] = useState(false)
  const preview = barcodeSvg(value || row.barcode, { height: 46, module: 1.5, showText: true })
  const ean = /^\d{13}$/.test(value) && isValidEan13(value)

  const save = async (barcode) => {
    setSaving(true)
    try {
      await adminAPI.updateBarcode({ itemId: row.id, barcode })
      toast.success(barcode ? "Barcode saved" : "Reset to an auto code")
      onSaved()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="p-5 sm:max-w-md sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-neutral-900">
            <BarcodeIcon className="h-5 w-5 text-primary" /> {row.name}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="flex min-h-[64px] items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 p-2" dangerouslySetInnerHTML={{ __html: preview }} />
          <label className="block">
            <span className="mb-1 block text-neutral-600">Manufacturer / custom barcode</span>
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Scan or type a code"
              className="h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 font-mono text-neutral-900 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <span className="mt-1 block text-xs text-neutral-400">
              {value ? (ean ? "Valid EAN-13." : "Will print as Code 128.") : "Leave empty to keep the auto-generated code."}
            </span>
          </label>
          <div className="flex items-center justify-between gap-2 pt-1">
            {row.source === "saved" ? (
              <button type="button" onClick={() => save("")} disabled={saving} className="rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-600 hover:bg-neutral-50">Reset to auto</button>
            ) : <span />}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="rounded-lg border border-neutral-300 px-4 py-2 font-medium text-neutral-700 hover:bg-neutral-50">Cancel</button>
              <button type="button" onClick={() => save(value.trim())} disabled={saving || !value.trim()} className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2 font-semibold text-white hover:opacity-90 disabled:opacity-50">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
