import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { ChevronDown, Download, Filter, Info, Loader2, Search, X, Package, ArrowRight, Plus, Minus, Equal, Upload, Columns3, ArrowLeftRight, SlidersHorizontal, Zap, FileSpreadsheet, FileText, History as HistoryIcon, Pencil } from "lucide-react"
import { toast } from "sonner"
import BarcodeScannerModal from "@food/components/restaurant/pos/BarcodeScannerModal"

import { adminAPI } from "@food/api"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@food/components/ui/dialog"
import { canCurrentAdminAction } from "@food/utils/adminRbac"
import BulkImportModal from "./BulkImportModal"

/**
 * Items > Stock — a replica of the reference ERP's stock register.
 *
 * Column set, Columns ▾ chooser, footer Total row, "Showing x to y of N
 * entries" and numbered pagination are the reference's. Product Name is a link
 * that opens the item's movement history, and Adjust Stock lives behind the row
 * menu; neither exists in the reference, but the ledger is the reason this
 * screen can be trusted, so both stay reachable from here.
 */

const COLUMNS = [
  { key: "srNo", label: "Sr. No.", always: true },
  { key: "itemCode", label: "Item Code" },
  { key: "name", label: "Product Name", always: true },
  { key: "restaurantName", label: "Store" },
  { key: "departmentName", label: "Department Name" },
  { key: "categoryName", label: "Category Name" },
  { key: "subCategoryName", label: "Sub Category Name" },
  { key: "brandName", label: "Brand Name" },
  { key: "subBrandName", label: "Sub Brand Name" },
  { key: "unitName", label: "Unit", info: "Primary selling unit of the product" },
  { key: "totalAvailableQty", label: "Total Available Qty", numeric: true },
  { key: "testingQty", label: "Testing Qty", numeric: true },
  { key: "purchasePrice", label: "Purchase cost", numeric: true },
  { key: "sellingPrice", label: "Selling price", numeric: true },
  { key: "margin", label: "Margin %", numeric: true },
  { key: "stockStatus", label: "Status" },
]

const TYPE_LABEL = { opening: "Opening", sale: "Sale", sale_return: "Sale Return", adjustment: "Adjustment", verification: "Verification", purchase: "Purchase" }
const REASONS = ["Purchase received", "Damaged", "Expired", "Theft / Loss", "Counting correction", "Sample / Free", "Other"]
const num = (v) => Number(v || 0).toFixed(2)
const when = (d) => (d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—")

/** 1 … 4 5 [6] 7 8 … 142 — the reference's page strip. */
const pageStrip = (page, totalPages) => {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
  const out = [1]
  const from = Math.max(2, page - 1)
  const to = Math.min(totalPages - 1, page + 1)
  if (from > 2) out.push("…")
  for (let i = from; i <= to; i++) out.push(i)
  if (to < totalPages - 1) out.push("…")
  out.push(totalPages)
  return out
}

export default function Stocks() {
  const [rows, setRows] = useState([])
  const [totals, setTotals] = useState({ totalAvailableQty: 0, testingQty: 0 })
  const [summary, setSummary] = useState({ products: 0, drafts: 0, lowStock: 0, outOfStock: 0, stockValue: 0, subscribable: 0 })
  const [bulkOpen, setBulkOpen] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [search, setSearch] = useState("")
  const [debounced, setDebounced] = useState("")
  const [menuFor, setMenuFor] = useState(null)

  const [colsOpen, setColsOpen] = useState(false)
  const [visible, setVisible] = useState(() => new Set(COLUMNS.map((c) => c.key)))
  const [exportMenu, setExportMenu] = useState(false)

  const [filterOpen, setFilterOpen] = useState(true)
  const [compare, setCompare] = useState(null)  // { picking:Set, data:[], loading } or null
  const [filters, setFilters] = useState({ restaurantId: "", departmentId: "", categoryId: "", brandId: "", unitId: "", status: "" })
  const [applied, setApplied] = useState(filters)
  const [lookups, setLookups] = useState({ restaurants: [], departments: [], categories: [], brands: [], units: [] })

  const [adjust, setAdjust] = useState(null)
  const [adjForm, setAdjForm] = useState({ mode: "add", qty: "", reason: REASONS[0], note: "" })
  const [adjusting, setAdjusting] = useState(false)

  const [history, setHistory] = useState(null)
  const [moves, setMoves] = useState([])
  const [movesLoading, setMovesLoading] = useState(false)

  const navigate = useNavigate()
  const [minDraft, setMinDraft] = useState({})   // inline min-stock edits, keyed by id
  const [bulkMin, setBulkMin] = useState("")      // "Set for shown" value
  const [subFilter, setSubFilter] = useState("")  // "", "yes", "no" — client-side

  const canEdit = canCurrentAdminAction("edit", "/admin/store/stocks")
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const cols = useMemo(() => COLUMNS.filter((c) => visible.has(c.key)), [visible])

  // Inventory-control sidebar links deep-link into this page: ?view=import opens
  // the bulk importer, ?view=transfers opens the store comparison. Others simply
  // land here. Runs once per view value.
  const [searchParams] = useSearchParams()
  useEffect(() => {
    const view = searchParams.get("view")
    if (view === "import") setBulkOpen(true)
    else if (view === "scan") setScanOpen(true)
    else if (view === "transfers") setCompare({ picking: new Set(), data: [], loading: false })
  }, [searchParams])

  useEffect(() => {
    const id = window.setTimeout(() => { setDebounced(search.trim()); setPage(1) }, 300)
    return () => window.clearTimeout(id)
  }, [search])

  useEffect(() => {
    ;(async () => {
      try {
        const [r, d, c, b, u] = await Promise.all([
          adminAPI.getRestaurants({ limit: 1000 }),
          adminAPI.getDepartments({ limit: 200 }),
          adminAPI.getCategories({ limit: 1000 }),
          adminAPI.getBrands({ limit: 200 }),
          adminAPI.getUnits({ limit: 200 }),
        ])
        const cats = c?.data?.data?.categories || c?.data?.data || []
        setLookups({
          restaurants: r?.data?.data?.restaurants || r?.data?.restaurants || [],
          departments: d?.data?.data?.departments || [],
          categories: Array.isArray(cats) ? cats : [],
          brands: b?.data?.data?.brands || [],
          units: u?.data?.data?.units || [],
        })
      } catch { /* filters degrade to search */ }
    })()
  }, [])

  const fetchRows = useCallback(async () => {
    setLoading(true)
    try {
      const params = { page, limit: pageSize }
      if (debounced) params.search = debounced
      Object.entries(applied).forEach(([k, v]) => { if (v) params[k] = v })
      const res = await adminAPI.getStocks(params)
      const d = res?.data?.data || {}
      setRows(d.stocks || [])
      setTotal(Number(d.total) || 0)
      setTotals(d.totals || { totalAvailableQty: 0, testingQty: 0 })
      setSummary(d.summary || { products: 0, drafts: 0, lowStock: 0, outOfStock: 0, stockValue: 0, subscribable: 0 })
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to load stock")
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, debounced, applied])

  useEffect(() => { fetchRows() }, [fetchRows])

  const openAdjust = (row) => {
    setMenuFor(null)
    setAdjForm({ mode: row.stockQty === null ? "set" : "add", qty: "", reason: REASONS[0], note: "" })
    setAdjust(row)
  }

  // Scan & update stock: a scanned barcode finds its product and opens the stock dialog for it.
  const onScanCode = async (code) => {
    try {
      const res = await adminAPI.getStocks({ search: code, limit: 5 })
      const found = (res?.data?.data?.stocks || []).filter((r) => String(r.barcode || "") === String(code) || String(r.itemCode || "") === String(code))
      if (found.length !== 1) return { ok: false, message: found.length ? `More than one product matches ${code}` : `No product with barcode ${code}` }
      setScanOpen(false)
      openAdjust(found[0])
      return { ok: true, message: `Found ${found[0].name}` }
    } catch {
      return { ok: false, message: "Could not look that barcode up" }
    }
  }

  const submitAdjust = async (e) => {
    e.preventDefault()
    setAdjusting(true)
    try {
      const res = await adminAPI.adjustStock({ itemId: adjust.id, mode: adjForm.mode, qty: Number(adjForm.qty), reason: adjForm.reason, note: adjForm.note })
      toast.success(`${adjust.name}: ${num(res?.data?.data?.qtyBefore)} → ${num(res?.data?.data?.stockQty)}`)
      setAdjust(null)
      fetchRows()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Adjustment failed")
    } finally {
      setAdjusting(false)
    }
  }

  const openHistory = async (row) => {
    setMenuFor(null)
    setHistory(row)
    setMoves([])
    setMovesLoading(true)
    try {
      const res = await adminAPI.getItemStockMovements(row.id, { limit: 100 })
      setMoves(res?.data?.data?.movements || [])
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to load history")
    } finally {
      setMovesLoading(false)
    }
  }

  const exportCsv = () => {
    setExportMenu(false)
    if (!rows.length) return toast.error("Nothing to export")
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`
    const head = cols.filter((c) => c.key !== "srNo").map((c) => c.label)
    // Same distinction as the table: an untracked product exports an empty
    // cell, so a spreadsheet total does not count it as a zero.
    const out = (r, c) => (c.key === "totalAvailableQty" && r.stockQty === null ? "" : c.numeric ? num(r[c.key]) : r[c.key] ?? "")
    const lines = rows.map((r) => cols.filter((c) => c.key !== "srNo").map((c) => out(r, c)).map(esc).join(","))
    const blob = new Blob([[head.map(esc).join(","), ...lines].join("\n")], { type: "text/csv" })
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `stock-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href)
  }

  const exportExcel = () => {
    setExportMenu(false)
    if (!rows.length) return toast.error("Nothing to export")
    const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    const head = cols.filter((c) => c.key !== "srNo")
    const th = head.map((c) => `<th>${esc(c.label)}</th>`).join("")
    const trs = rows.map((r) => `<tr>${head.map((c) => `<td>${esc(c.key === "totalAvailableQty" && r.stockQty === null ? "" : c.numeric ? num(r[c.key]) : r[c.key] ?? "")}</td>`).join("")}</tr>`).join("")
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body><table border="1">${`<tr>${th}</tr>`}${trs}</table></body></html>`
    const blob = new Blob([html], { type: "application/vnd.ms-excel" })
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `inventory-${new Date().toISOString().slice(0, 10)}.xls`; a.click(); URL.revokeObjectURL(a.href)
  }

  const minVal = (row) => (row.id in minDraft ? minDraft[row.id] : (row.lowStockThreshold ?? ""))
  const saveMinStock = async (row) => {
    if (!(row.id in minDraft)) return
    const value = minDraft[row.id]
    if (String(value) === String(row.lowStockThreshold ?? "")) { setMinDraft((d) => { const n = { ...d }; delete n[row.id]; return n }); return }
    try {
      const res = await adminAPI.setStockMeta({ itemId: row.id, minStock: value })
      const u = res?.data?.data || {}
      setRows((list) => list.map((it) => it.id === row.id ? { ...it, lowStockThreshold: u.lowStockThreshold } : it))
      setMinDraft((d) => { const n = { ...d }; delete n[row.id]; return n })
    } catch (e) { toast.error(e?.response?.data?.message || "Could not save min stock") }
  }
  const toggleSub = async (row) => {
    const next = !row.subscriptionEnabled
    setRows((list) => list.map((it) => it.id === row.id ? { ...it, subscriptionEnabled: next } : it))
    try { await adminAPI.setStockMeta({ itemId: row.id, subscriptionEnabled: next }) }
    catch (e) { toast.error("Could not update subscription"); setRows((list) => list.map((it) => it.id === row.id ? { ...it, subscriptionEnabled: !next } : it)) }
  }
  const setForShown = async () => {
    if (bulkMin === "" || Number(bulkMin) < 0) return toast.error("Enter a min stock first")
    const v = Number(bulkMin)
    try {
      await Promise.all(rows.map((r) => adminAPI.setStockMeta({ itemId: r.id, minStock: v })))
      setRows((list) => list.map((it) => ({ ...it, lowStockThreshold: v })))
      toast.success(`Min stock set to ${v} for ${rows.length} shown`)
    } catch { toast.error("Some products could not be updated") }
  }

  const toggleCompareStore = (id) =>
    setCompare((c) => {
      const picking = new Set(c?.picking || [])
      picking.has(id) ? picking.delete(id) : picking.add(id)
      return { ...c, picking }
    })
  const runCompare = async () => {
    const ids = [...(compare?.picking || [])]
    if (ids.length < 2) { toast.error("Pick at least two stores to compare"); return }
    setCompare((c) => ({ ...c, loading: true }))
    try {
      const res = await adminAPI.getStockComparison(ids)
      setCompare((c) => ({ ...c, data: res?.data?.data?.stores || [], loading: false }))
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to compare stores")
      setCompare((c) => ({ ...c, loading: false }))
    }
  }

  // Store-first: picking a store applies immediately (no Apply click needed).
  const selectStore = (id) => {
    setFilters((f) => ({ ...f, restaurantId: id }))
    setApplied((a) => ({ ...a, restaurantId: id }))
    setPage(1)
  }
  const applyFilters = () => { setApplied(filters); setPage(1) }
  const clearFilters = () => { const e = { restaurantId: "", departmentId: "", categoryId: "", brandId: "", unitId: "", status: "" }; setFilters(e); setApplied(e); setPage(1) }
  const nFilters = Object.values(applied).filter(Boolean).length

  const cell = (row, c, i) => {
    if (c.key === "srNo") return <span className="text-neutral-700">{(page - 1) * pageSize + i + 1}</span>
    if (c.key === "name") return <button type="button" onClick={() => openHistory(row)} className="font-medium text-sky-600 hover:underline">{row.name}</button>
    // An untracked product has no count, which is not the same as a count of
    // zero — printing 0.00 reads as "sold out" and sends someone to restock a
    // shelf that was never being counted. The movement table already says "—"
    // for an unknown quantity; say it here too.
    if (c.key === "totalAvailableQty" && row.stockQty === null) return <span className="text-neutral-400" title="Not tracked">—</span>
    if (c.key === "purchasePrice" || c.key === "sellingPrice") return row[c.key] == null ? <span className="text-neutral-400">—</span> : `₹${Number(row[c.key]).toLocaleString("en-IN")}`
    if (c.key === "margin") return row.margin == null ? <span className="text-neutral-400">—</span> : <span className={row.margin < 0 ? "font-medium text-red-600" : row.margin < 10 ? "font-medium text-amber-600" : "font-medium text-emerald-600"}>{row.margin}%</span>
    if (c.key === "stockStatus") return <StatusBadge status={row.status} available={row.isAvailable} />
    if (c.numeric) return num(row[c.key])
    return row[c.key] || ""
  }

  // Subscription filter is client-side over the current page.
  const shownRows = subFilter ? rows.filter((r) => (subFilter === "yes" ? r.subscriptionEnabled : !r.subscriptionEnabled)) : rows

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-neutral-900">Inventory</h1>
          <p className="text-sm text-neutral-500">Create and manage products · {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={exportCsv} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-700 hover:border-emerald-400 hover:text-emerald-700"><FileText className="h-4 w-4" /> CSV</button>
          <button type="button" onClick={exportExcel} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-700 hover:border-emerald-400 hover:text-emerald-700"><FileSpreadsheet className="h-4 w-4" /> Excel</button>
          <button type="button" onClick={() => navigate("/admin/store/products/new")} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700"><Plus className="h-4 w-4" /> New product</button>
        </div>
      </div>

      {/* KPI tiles — summarise the current store view */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi label="Products" value={summary.products} sub={`${summary.drafts} draft${summary.drafts === 1 ? "" : "s"}`} />
        <Kpi label="Low stock" value={summary.lowStock} tone={summary.lowStock > 0 ? "amber" : "default"} />
        <Kpi label="Out of stock" value={summary.outOfStock} tone={summary.outOfStock > 0 ? "red" : "default"} />
        <Kpi label="Stock value (at cost)" value={`₹${Number(summary.stockValue || 0).toLocaleString("en-IN")}`} />
        <Kpi label="Subscribable" value={summary.subscribable} tone="green" />
      </div>

      {/* Stock view — all stores combined, one shop, or a side-by-side compare */}
      <div className="mb-4 rounded-xl border border-neutral-200 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">Stock view</span>
          <button type="button" onClick={() => selectStore("")} className={`h-9 rounded-full px-3 text-sm font-medium ${applied.restaurantId === "" ? "bg-emerald-600 text-white" : "border border-neutral-300 text-neutral-700 hover:border-emerald-400 hover:text-emerald-700"}`}>All stores · combined</button>
          {lookups.restaurants.map((r) => {
            const id = String(r._id || r.id)
            return <button key={id} type="button" onClick={() => selectStore(id)} className={`h-9 rounded-full px-3 text-sm font-medium ${applied.restaurantId === id ? "bg-emerald-600 text-white" : "border border-neutral-300 text-neutral-700 hover:border-emerald-400 hover:text-emerald-700"}`}>{r.restaurantName || r.name}</button>
          })}
          <button type="button" onClick={() => setCompare({ picking: new Set(), data: [], loading: false })} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-neutral-300 px-3 text-sm font-medium text-neutral-700 hover:border-emerald-400 hover:text-emerald-700"><ArrowLeftRight className="h-4 w-4" /> Compare stores</button>
        </div>
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
          {applied.restaurantId ? "Showing one store" : "All stores combined"} · stock, value and low / out counts {applied.restaurantId ? "for this store" : "add up every store you can access"}.
        </p>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-3 shadow-sm">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Product, brand, SKU" className="h-9 w-full rounded-lg border border-neutral-300 bg-white pl-8 pr-3 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100" />
          </div>
          <select value={applied.categoryId} onChange={(e) => { setApplied((a) => ({ ...a, categoryId: e.target.value })); setFilters((f) => ({ ...f, categoryId: e.target.value })); setPage(1) }} className="h-9 rounded-lg border border-neutral-300 bg-white px-2 text-sm text-neutral-700 outline-none focus:border-emerald-400">
            <option value="">All categories</option>
            {lookups.categories.map((c) => <option key={c._id || c.id} value={c._id || c.id}>{c.name}</option>)}
          </select>
          <select value={subFilter} onChange={(e) => setSubFilter(e.target.value)} className="h-9 rounded-lg border border-neutral-300 bg-white px-2 text-sm text-neutral-700 outline-none focus:border-emerald-400">
            <option value="">Subscription: any</option>
            <option value="yes">Subscribable</option>
            <option value="no">Not subscribable</option>
          </select>
          <select value={applied.status} onChange={(e) => { setApplied((a) => ({ ...a, status: e.target.value })); setFilters((f) => ({ ...f, status: e.target.value })); setPage(1) }} className="h-9 rounded-lg border border-neutral-300 bg-white px-2 text-sm text-neutral-700 outline-none focus:border-emerald-400">
            <option value="">Any stock</option>
            <option value="in_stock">In stock</option>
            <option value="low">Low stock</option>
            <option value="out">Out of stock</option>
            <option value="untracked">Untracked</option>
          </select>
          <input type="number" min={0} value={bulkMin} onChange={(e) => setBulkMin(e.target.value)} placeholder="Min stock" className="h-9 w-24 rounded-lg border border-neutral-300 bg-white px-2 text-sm outline-none focus:border-emerald-400" />
          <button type="button" onClick={setForShown} className="h-9 rounded-lg border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-700 hover:border-emerald-400 hover:text-emerald-700">Set for shown</button>
          <button type="button" onClick={() => setBulkOpen(true)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-emerald-500 bg-white px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-50"><Upload className="h-4 w-4" /> Bulk import</button>
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }} className="h-9 rounded-lg border border-neutral-300 bg-white px-2 text-sm text-neutral-700 outline-none focus:border-emerald-400">
            {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
          </select>
        </div>

        {/* Table */}
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[1180px] text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="py-3 pr-4 font-medium">Product</th>
                <th className="py-3 pr-4 font-medium">Category</th>
                <th className="py-3 pr-4 font-medium">Stock</th>
                <th className="py-3 pr-4 font-medium">Min stock</th>
                <th className="py-3 pr-4 font-medium">Purchase cost</th>
                <th className="py-3 pr-4 font-medium">Selling price</th>
                <th className="py-3 pr-4 font-medium">Margin %</th>
                <th className="py-3 pr-4 font-medium">Ordering</th>
                <th className="py-3 pr-4 font-medium">Subscription</th>
                <th className="py-3 pr-4 font-medium">Status</th>
                <th className="py-3 pr-2 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={11} className="py-14 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-neutral-300" /></td></tr>
              ) : shownRows.length === 0 ? (
                <tr><td colSpan={11} className="py-14 text-center text-neutral-500">No products found.</td></tr>
              ) : shownRows.map((row) => (
                <tr key={row.id} className="border-b border-neutral-100 align-middle hover:bg-neutral-50">
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2.5">
                      <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-100">
                        {row.image ? <img src={row.image} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-neutral-300"><Package className="h-4 w-4" /></div>}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-neutral-900">{row.name}</div>
                        <div className="text-xs text-neutral-400">{[row.unitName, row.itemCode].filter(Boolean).join(" · ") || "—"}</div>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 pr-4">
                    <div className="text-neutral-700">{row.categoryName || "—"}</div>
                    {row.subCategoryName && <div className="text-xs text-neutral-400">{row.subCategoryName}</div>}
                  </td>
                  <td className="py-3 pr-4 font-semibold text-neutral-900">{row.stockQty === null ? <span className="text-neutral-400">—</span> : Number(row.stockQty)}</td>
                  <td className="py-3 pr-4">
                    <input type="number" min={0} value={minVal(row)} onChange={(e) => setMinDraft((d) => ({ ...d, [row.id]: e.target.value }))} onBlur={() => saveMinStock(row)}
                      className="h-9 w-20 rounded-lg border border-neutral-300 bg-white px-2 text-sm text-neutral-900 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100" />
                  </td>
                  <td className="py-3 pr-4 text-neutral-700">{row.purchasePrice == null ? <span className="text-neutral-400">—</span> : `₹${Number(row.purchasePrice).toLocaleString("en-IN")}`}</td>
                  <td className="py-3 pr-4 font-medium text-neutral-800">{row.sellingPrice == null ? <span className="text-neutral-400">—</span> : `₹${Number(row.sellingPrice).toLocaleString("en-IN")}`}</td>
                  <td className="py-3 pr-4">{row.margin == null ? <span className="text-neutral-400">—</span> : <span className={`font-semibold ${row.margin < 0 ? "text-red-600" : row.margin < 10 ? "text-amber-600" : "text-emerald-600"}`}>{row.margin}%</span>}</td>
                  <td className="py-3 pr-4">
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600"><Zap className="h-3.5 w-3.5" /> Instant</span>
                    <div className="text-[11px] text-neutral-400">cut-off 22:00</div>
                  </td>
                  <td className="py-3 pr-4">
                    <button type="button" onClick={() => toggleSub(row)} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${row.subscriptionEnabled ? "bg-emerald-100 text-emerald-700" : "bg-neutral-100 text-neutral-500"}`}>{row.subscriptionEnabled ? "Yes" : "No"}</button>
                  </td>
                  <td className="py-3 pr-4"><StatusBadge status={row.status} available={row.isAvailable} /></td>
                  <td className="py-3 pr-2">
                    <div className="flex items-center justify-end gap-1.5">
                      <button type="button" onClick={() => openHistory(row)} className="inline-flex items-center gap-1 rounded-full border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:border-emerald-400 hover:text-emerald-700"><HistoryIcon className="h-3.5 w-3.5" /> Ledger</button>
                      {canEdit && <button type="button" onClick={() => openAdjust(row)} className="inline-flex items-center gap-1 rounded-full border border-emerald-500 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"><Plus className="h-3.5 w-3.5" /> Stock</button>}
                      <button type="button" onClick={() => navigate(`/admin/store/products/${row.id}/edit`)} className="inline-flex items-center gap-1 rounded-full border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:border-emerald-400 hover:text-emerald-700"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-neutral-100 pt-3 text-sm text-neutral-600">
          <span>Showing {rows.length ? (page - 1) * pageSize + 1 : 0} to {(page - 1) * pageSize + rows.length} of {total.toLocaleString("en-IN")} entries</span>
          <div className="flex items-center gap-1">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border border-neutral-300 px-2.5 py-1 disabled:opacity-40">‹</button>
            {pageStrip(page, totalPages).map((n, i) =>
              n === "…" ? <span key={`e${i}`} className="px-1 text-neutral-400">…</span> : (
                <button key={n} type="button" onClick={() => setPage(n)} className={`h-8 min-w-8 rounded px-2 ${n === page ? "bg-emerald-600 font-semibold text-white" : "hover:bg-neutral-100"}`}>{n}</button>
              )
            )}
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded border border-neutral-300 px-2.5 py-1 disabled:opacity-40">›</button>
          </div>
        </div>
      </div>

      {scanOpen ? <BarcodeScannerModal onScan={onScanCode} onClose={() => setScanOpen(false)} /> : null}

      <Dialog open={Boolean(adjust)} onOpenChange={(o) => !o && setAdjust(null)}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
          {adjust && (() => {
            const q = Number(adjForm.qty) || 0
            const cur = adjust.stockQty ?? 0
            const untracked = adjust.stockQty === null
            const next = adjForm.mode === "add" ? cur + q : adjForm.mode === "remove" ? cur - q : q
            const clampedNext = Math.max(0, next)
            const overRemove = adjForm.mode === "remove" && q > cur
            const delta = clampedNext - cur
            const MODES = [
              { m: "add", label: "Add", Icon: Plus, on: "border-primary bg-primary text-white shadow-sm" },
              { m: "remove", label: "Remove", Icon: Minus, on: "border-rose-500 bg-rose-500 text-white shadow-sm" },
              { m: "set", label: "Set", Icon: Equal, on: "border-slate-700 bg-slate-700 text-white shadow-sm" },
            ]
            const nextTone = overRemove || adjForm.mode === "remove" ? "text-rose-600" : adjForm.mode === "set" ? "text-slate-700" : "text-primary"
            const bump = (d) => setAdjForm((f) => ({ ...f, qty: String(Math.max(0, (Number(f.qty) || 0) + d)) }))
            return (
              <form onSubmit={submitAdjust} className="text-sm">
                {/* header */}
                <div className="flex items-center gap-2.5 border-b border-neutral-100 px-5 py-4">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600"><Package className="h-5 w-5" /></span>
                  <div>
                    <DialogTitle className="text-base font-bold leading-tight text-neutral-900">Adjust stock</DialogTitle>
                    <p className="text-xs text-neutral-500">Record a manual stock movement</p>
                  </div>
                </div>

                <div className="space-y-4 px-5 py-4">
                  {/* item + current stock */}
                  <div className="flex items-center justify-between rounded-xl border border-neutral-200 bg-gradient-to-br from-neutral-50 to-white px-4 py-3">
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-neutral-900">{adjust.name}</div>
                      <div className="text-xs text-neutral-500">{adjust.itemCode || "No code"}{adjust.unitName ? ` · ${adjust.unitName}` : ""}</div>
                    </div>
                    <div className="shrink-0 pl-3 text-right">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">In stock</div>
                      <div className="text-2xl font-bold leading-none text-neutral-900">{untracked ? "—" : num(cur)}</div>
                    </div>
                  </div>

                  {/* mode */}
                  <div className="grid grid-cols-3 gap-2">
                    {MODES.map(({ m, label, Icon, on }) => (
                      <button key={m} type="button" disabled={untracked && m !== "set"}
                        onClick={() => setAdjForm((f) => ({ ...f, mode: m }))}
                        className={`flex items-center justify-center gap-1.5 rounded-lg border py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${adjForm.mode === m ? on : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300 hover:bg-neutral-50"}`}>
                        <Icon className="h-4 w-4" /> {label}
                      </button>
                    ))}
                  </div>
                  {untracked && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">This product is untracked — use <b>Set</b> to give it an opening quantity.</p>}

                  {/* quantity with steppers */}
                  <label className="block">
                    <span className="mb-1.5 block font-medium text-neutral-700">Quantity<span className="text-rose-500">*</span></span>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => bump(-1)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-neutral-300 text-neutral-600 hover:bg-neutral-50"><Minus className="h-4 w-4" /></button>
                      <input type="number" min={0} step="any" required autoFocus value={adjForm.qty} onChange={(e) => setAdjForm((f) => ({ ...f, qty: e.target.value }))} placeholder="0" className="h-11 w-full rounded-lg border border-neutral-300 px-3 text-center text-base font-semibold outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100" />
                      <button type="button" onClick={() => bump(1)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-neutral-300 text-neutral-600 hover:bg-neutral-50"><Plus className="h-4 w-4" /></button>
                    </div>
                  </label>

                  {/* live preview */}
                  {q > 0 && !untracked && (
                    <div className={`flex items-center justify-center gap-3 rounded-xl border py-3 ${overRemove ? "border-rose-200 bg-rose-50" : "border-neutral-200 bg-neutral-50"}`}>
                      <div className="text-center">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Now</div>
                        <div className="text-lg font-bold text-neutral-500">{num(cur)}</div>
                      </div>
                      <ArrowRight className="h-5 w-5 text-neutral-300" />
                      <div className="text-center">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">After</div>
                        <div className={`text-lg font-bold ${nextTone}`}>{num(clampedNext)}</div>
                      </div>
                      {!overRemove && delta !== 0 && (
                        <span className={`ml-1 rounded-full px-2 py-0.5 text-xs font-semibold ${delta > 0 ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>{delta > 0 ? "+" : ""}{num(delta)}</span>
                      )}
                    </div>
                  )}
                  {overRemove && <p className="-mt-1 text-xs font-medium text-rose-600">Only {num(cur)} in stock — removing {num(q)} would go below zero.</p>}

                  {/* reason + note */}
                  <label className="block"><span className="mb-1.5 block font-medium text-neutral-700">Reason<span className="text-rose-500">*</span></span><select value={adjForm.reason} onChange={(e) => setAdjForm((f) => ({ ...f, reason: e.target.value }))} className="h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100">{REASONS.map((r) => <option key={r}>{r}</option>)}</select></label>
                  <label className="block"><span className="mb-1.5 block font-medium text-neutral-700">Note</span><input value={adjForm.note} onChange={(e) => setAdjForm((f) => ({ ...f, note: e.target.value }))} placeholder="Optional" className="h-11 w-full rounded-lg border border-neutral-300 px-3 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100" /></label>
                </div>

                {/* footer */}
                <div className="flex justify-end gap-2 border-t border-neutral-100 bg-neutral-50 px-5 py-3">
                  <button type="button" onClick={() => setAdjust(null)} className="rounded-lg border border-neutral-300 bg-white px-4 py-2 font-medium text-neutral-700 hover:bg-neutral-50">Cancel</button>
                  <button type="submit" disabled={adjusting || overRemove || q <= 0} className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2 font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-50">{adjusting && <Loader2 className="h-4 w-4 animate-spin" />} Save</button>
                </div>
              </form>
            )
          })()}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(history)} onOpenChange={(o) => !o && setHistory(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto p-5 sm:max-w-3xl sm:p-6">
          <DialogHeader><DialogTitle className="text-sky-600">Stock History{history ? ` — ${history.name}` : ""}</DialogTitle></DialogHeader>
          {movesLoading ? <Loader2 className="mx-auto my-10 h-6 w-6 animate-spin text-neutral-400" /> : moves.length === 0 ? (
            <p className="py-8 text-center text-sm text-neutral-500">No movements yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-neutral-100 text-left text-xs text-neutral-700"><tr><th className="px-2 py-2">Date</th><th className="px-2 py-2">Type</th><th className="px-2 py-2 text-right">Change</th><th className="px-2 py-2 text-right">Before</th><th className="px-2 py-2 text-right">After</th><th className="px-2 py-2">Reason</th><th className="px-2 py-2">Ref</th><th className="px-2 py-2">By</th></tr></thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.id} className="border-t border-neutral-100">
                    <td className="whitespace-nowrap px-2 py-2 text-neutral-700">{when(m.createdAt)}</td>
                    <td className="px-2 py-2">{TYPE_LABEL[m.type] || m.type}</td>
                    <td className={`px-2 py-2 text-right font-semibold ${m.qtyChange > 0 ? "text-emerald-600" : m.qtyChange < 0 ? "text-rose-600" : "text-neutral-500"}`}>{m.qtyChange > 0 ? "+" : ""}{m.qtyChange}</td>
                    <td className="px-2 py-2 text-right text-neutral-600">{m.qtyBefore === null ? "—" : num(m.qtyBefore)}</td>
                    <td className="px-2 py-2 text-right text-neutral-900">{num(m.qtyAfter)}</td>
                    <td className="px-2 py-2 text-neutral-700">{m.reason}{m.note ? <span className="block text-xs text-neutral-500">{m.note}</span> : null}</td>
                    <td className="px-2 py-2 text-xs text-neutral-600">{m.reference?.label || (m.reference?.kind === "manual" ? "Manual" : m.reference?.kind || "—")}</td>
                    <td className="px-2 py-2 text-xs text-neutral-600">{m.createdBy?.role || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DialogContent>
      </Dialog>

      {/* Compare stores — side-by-side inventory snapshot. */}
      {compare && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={() => setCompare(null)}>
          <div className="w-full max-w-3xl rounded-lg bg-white shadow-xl flex flex-col max-h-[90vh]" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-base font-semibold text-neutral-800">Compare stores</h2>
              <button type="button" onClick={() => setCompare(null)} className="rounded p-1 text-neutral-500 hover:bg-neutral-100"><X size={18} /></button>
            </div>
            <div className="overflow-y-auto px-4 py-3">
              <div className="mb-3 flex flex-wrap gap-2">
                {lookups.restaurants.map((r) => {
                  const id = String(r._id || r.id)
                  const on = compare.picking?.has(id)
                  return (
                    <button key={id} type="button" onClick={() => toggleCompareStore(id)} className={`rounded-full border px-3 py-1.5 text-sm ${on ? "border-sky-500 bg-sky-50 text-sky-700" : "border-neutral-300 bg-white text-neutral-600"}`}>
                      {r.restaurantName || r.name}
                    </button>
                  )
                })}
              </div>
              <button type="button" onClick={runCompare} disabled={compare.loading} className="mb-3 inline-flex items-center gap-2 rounded bg-sky-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
                {compare.loading && <Loader2 className="h-4 w-4 animate-spin" />} Compare ({compare.picking?.size || 0})
              </button>

              {compare.data?.length > 0 && (
                <div className="overflow-x-auto rounded border border-neutral-200">
                  <table className="w-full text-sm">
                    <thead className="bg-neutral-50">
                      <tr><th className="px-3 py-2 text-left font-semibold text-neutral-700">Metric</th>{compare.data.map((s) => <th key={s.storeId} className="px-3 py-2 text-right font-semibold text-neutral-900">{s.store}</th>)}</tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {[
                        ["Products", (s) => s.products],
                        ["Tracked", (s) => s.tracked],
                        ["Available qty", (s) => num(s.availableQty)],
                        ["Stock value (₹)", (s) => `₹${Number(s.stockValue || 0).toLocaleString("en-IN")}`],
                        ["Low stock", (s) => s.low],
                        ["Out of stock", (s) => s.out],
                      ].map(([label, fn]) => (
                        <tr key={label}>
                          <td className="px-3 py-2 text-neutral-600">{label}</td>
                          {compare.data.map((s) => <td key={s.storeId} className={`px-3 py-2 text-right ${label === "Out of stock" && fn(s) > 0 ? "text-rose-600 font-medium" : label === "Low stock" && fn(s) > 0 ? "text-amber-600" : "text-neutral-800"}`}>{fn(s)}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {bulkOpen && (
        <BulkImportModal
          stores={lookups.restaurants}
          onClose={() => setBulkOpen(false)}
          onDone={fetchRows}
        />
      )}
    </div>
  )
}

const KPI_TONE = {
  default: "text-neutral-900",
  green: "text-emerald-600",
  amber: "text-amber-600",
  red: "text-red-600",
}

function Kpi({ label, value, sub, tone = "default" }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3.5 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${KPI_TONE[tone] || KPI_TONE.default}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-neutral-400">{sub}</div> : null}
    </div>
  )
}

const STATUS_STYLE = {
  in_stock: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  low: "bg-amber-50 text-amber-700 ring-amber-200",
  critical: "bg-orange-50 text-orange-700 ring-orange-200",
  out: "bg-red-50 text-red-700 ring-red-200",
  untracked: "bg-neutral-100 text-neutral-500 ring-neutral-200",
}
const STATUS_LABEL = { in_stock: "Live", low: "Low", critical: "Critical", out: "Out", untracked: "Untracked" }

function StatusBadge({ status, available }) {
  const s = status || "untracked"
  const label = s === "in_stock" && available === false ? "Hidden" : STATUS_LABEL[s] || s
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_STYLE[s] || STATUS_STYLE.untracked}`}>{label}</span>
}
