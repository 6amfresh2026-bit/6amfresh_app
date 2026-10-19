import { useCallback, useEffect, useMemo, useState } from "react"
import { ChevronDown, Download, Filter, Info, Loader2, Search } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@food/components/ui/dialog"
import { canCurrentAdminAction } from "@food/utils/adminRbac"

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
  const [filters, setFilters] = useState({ restaurantId: "", departmentId: "", categoryId: "", brandId: "", unitId: "", status: "" })
  const [applied, setApplied] = useState(filters)
  const [lookups, setLookups] = useState({ restaurants: [], departments: [], categories: [], brands: [], units: [] })

  const [adjust, setAdjust] = useState(null)
  const [adjForm, setAdjForm] = useState({ mode: "add", qty: "", reason: REASONS[0], note: "" })
  const [adjusting, setAdjusting] = useState(false)

  const [history, setHistory] = useState(null)
  const [moves, setMoves] = useState([])
  const [movesLoading, setMovesLoading] = useState(false)

  const canEdit = canCurrentAdminAction("edit", "/admin/store/stocks")
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const cols = useMemo(() => COLUMNS.filter((c) => visible.has(c.key)), [visible])

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
    if (c.numeric) return num(row[c.key])
    return row[c.key] || ""
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex items-center gap-2 text-lg">
        <span className="font-semibold text-neutral-900">Stock</span>
        <span className="text-neutral-300">|</span>
        <span className="text-neutral-400">⌂</span>
      </div>

      <div className="rounded-md border border-neutral-200 bg-white p-4 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {/* Store-wise: pick a store to manage just its inventory. */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-neutral-600">Store</span>
            <select
              value={applied.restaurantId}
              onChange={(e) => selectStore(e.target.value)}
              className="h-9 min-w-[12rem] rounded border border-neutral-300 bg-white px-2 text-sm font-medium outline-none focus:border-sky-500"
            >
              <option value="">All stores</option>
              {lookups.restaurants.map((r) => (
                <option key={r._id || r.id} value={r._id || r.id}>{r.restaurantName || r.name}</option>
              ))}
            </select>
          </div>
          <div className="relative">
            <button type="button" onClick={() => setColsOpen((v) => !v)} className="inline-flex h-9 items-center gap-2 rounded bg-sky-500 px-3 text-sm font-medium text-white hover:bg-sky-600">
              Columns <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {colsOpen && (
              <div className="absolute z-20 mt-1 w-60 rounded border border-neutral-200 bg-white py-1 text-sm shadow-lg">
                {COLUMNS.map((c) => (
                  <label key={c.key} className={`flex items-center gap-2 px-3 py-1.5 ${c.always ? "opacity-60" : "hover:bg-neutral-50"}`}>
                    <input
                      type="checkbox"
                      disabled={c.always}
                      checked={visible.has(c.key)}
                      onChange={() => setVisible((s) => { const n = new Set(s); n.has(c.key) ? n.delete(c.key) : n.add(c.key); return n })}
                      className="h-4 w-4 rounded border-neutral-300 accent-sky-500"
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative">
              <button type="button" onClick={() => setExportMenu((v) => !v)} className="inline-flex h-9 items-center gap-1 rounded bg-sky-500 px-3 text-sm font-medium text-white hover:bg-sky-600" aria-label="Export">
                <Download className="h-4 w-4" /> <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {exportMenu && <div className="absolute right-0 z-20 mt-1 w-40 rounded border border-neutral-200 bg-white py-1 text-sm shadow-lg"><button type="button" onClick={exportCsv} className="block w-full px-3 py-1.5 text-left hover:bg-neutral-50">This page (CSV)</button></div>}
            </div>
            <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }} className="h-9 rounded border border-neutral-300 bg-white px-2 text-sm">
              {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <button type="button" onClick={() => setFilterOpen((v) => !v)} className="inline-flex h-9 items-center gap-2 rounded bg-sky-500 px-3 text-sm font-medium text-white hover:bg-sky-600"><Filter className="h-4 w-4" /> Filter{nFilters ? ` (${nFilters})` : ""}</button>
            <div className="relative">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search List..." className="h-9 w-52 rounded border border-neutral-300 bg-white pl-3 pr-8 text-sm outline-none focus:border-sky-500" />
              <Search className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            </div>
          </div>
        </div>

        {filterOpen && (
          <div className="mb-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <select value={filters.restaurantId} onChange={(e) => setFilters((f) => ({ ...f, restaurantId: e.target.value }))} className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"><option value="">All Stores</option>{lookups.restaurants.map((r) => <option key={r._id || r.id} value={r._id || r.id}>{r.restaurantName || r.name}</option>)}</select>
              <select value={filters.departmentId} onChange={(e) => setFilters((f) => ({ ...f, departmentId: e.target.value }))} className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"><option value="">All Departments</option>{lookups.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
              <select value={filters.categoryId} onChange={(e) => setFilters((f) => ({ ...f, categoryId: e.target.value }))} className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"><option value="">All Categories</option>{lookups.categories.map((c) => <option key={c._id || c.id} value={c._id || c.id}>{c.name}</option>)}</select>
              <select value={filters.brandId} onChange={(e) => setFilters((f) => ({ ...f, brandId: e.target.value }))} className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"><option value="">All Brands</option>{lookups.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
              <select value={filters.unitId} onChange={(e) => setFilters((f) => ({ ...f, unitId: e.target.value }))} className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"><option value="">All Units</option>{lookups.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
              <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"><option value="">Any Status</option><option value="in_stock">In Stock</option><option value="low">Low Stock</option><option value="out">Out Of Stock</option><option value="untracked">Untracked</option></select>
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={clearFilters} className="rounded bg-neutral-200 px-3 py-1.5 text-sm">Clear</button>
              <button type="button" onClick={applyFilters} className="rounded bg-sky-500 px-3 py-1.5 text-sm text-white">Apply</button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] border border-neutral-200 text-sm">
            <thead className="bg-neutral-100 text-left text-neutral-800">
              <tr>
                {cols.map((c) => (
                  <th key={c.key} className={`border-r border-neutral-200 px-3 py-3 font-semibold last:border-r-0 ${c.numeric ? "text-right" : ""}`}>
                    <span className="inline-flex items-center gap-1">{c.label}{c.info && <Info className="h-3.5 w-3.5 text-sky-500" aria-label={c.info} />}</span>
                  </th>
                ))}
                <th className="px-3 py-3 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={cols.length + 1} className="px-3 py-14 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-neutral-400" /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={cols.length + 1} className="px-3 py-14 text-center text-neutral-500">No products found.</td></tr>
              ) : rows.map((row, i) => (
                <tr key={row.id} className="border-t border-neutral-200">
                  {cols.map((c) => (
                    <td key={c.key} className={`border-r border-neutral-200 px-3 py-3 text-neutral-700 last:border-r-0 ${c.numeric ? "text-right" : ""}`}>{cell(row, c, i)}</td>
                  ))}
                  <td className="relative px-3 py-3">
                    <button type="button" onClick={() => setMenuFor(menuFor === row.id ? null : row.id)} className="px-2 text-lg leading-none text-neutral-500 hover:text-neutral-800" aria-label="Actions">···</button>
                    {menuFor === row.id && (
                      <div className="absolute right-2 z-10 mt-1 w-36 rounded border border-neutral-200 bg-white py-1 text-sm shadow-lg">
                        {canEdit && <button type="button" onClick={() => openAdjust(row)} className="block w-full px-3 py-1.5 text-left hover:bg-neutral-50">Adjust Stock</button>}
                        <button type="button" onClick={() => openHistory(row)} className="block w-full px-3 py-1.5 text-left hover:bg-neutral-50">History</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            {!loading && rows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-neutral-300 bg-neutral-100 font-semibold text-neutral-800">
                  {cols.map((c, idx) => (
                    <td key={c.key} className={`border-r border-neutral-200 px-3 py-3 last:border-r-0 ${c.numeric ? "text-right" : ""}`}>
                      {c.key === "totalAvailableQty" ? num(totals.totalAvailableQty)
                        : c.key === "testingQty" ? num(totals.testingQty)
                        : idx === 1 || (idx === 0 && cols.length === 1) ? "Total" : ""}
                    </td>
                  ))}
                  <td className="px-3 py-3" />
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-neutral-600">
          <span>Showing {rows.length ? (page - 1) * pageSize + 1 : 0} to {(page - 1) * pageSize + rows.length} of {total.toLocaleString("en-IN")} entries</span>
          <div className="flex items-center gap-1">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border border-neutral-300 px-2.5 py-1 disabled:opacity-40">‹</button>
            {pageStrip(page, totalPages).map((n, i) =>
              n === "…" ? <span key={`e${i}`} className="px-1 text-neutral-400">…</span> : (
                <button key={n} type="button" onClick={() => setPage(n)} className={`h-8 min-w-8 rounded px-2 ${n === page ? "bg-sky-500 font-semibold text-white" : "hover:bg-neutral-100"}`}>{n}</button>
              )
            )}
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded border border-neutral-300 px-2.5 py-1 disabled:opacity-40">›</button>
          </div>
        </div>
      </div>

      <Dialog open={Boolean(adjust)} onOpenChange={(o) => !o && setAdjust(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-sky-600">Adjust Stock</DialogTitle></DialogHeader>
          {adjust && (
            <form onSubmit={submitAdjust} className="space-y-3 text-sm">
              <div className="rounded bg-neutral-50 p-3"><div className="font-medium text-neutral-900">{adjust.name}</div><div className="text-xs text-neutral-500">{adjust.itemCode} · Current: <b>{num(adjust.stockQty)}</b> {adjust.unitShortName}</div></div>
              <div className="grid grid-cols-3 gap-1 rounded bg-neutral-100 p-1">
                {[["add", "+ Add"], ["remove", "− Remove"], ["set", "= Set"]].map(([m, l]) => (
                  <button key={m} type="button" disabled={adjust.stockQty === null && m !== "set"} onClick={() => setAdjForm((f) => ({ ...f, mode: m }))} className={`rounded py-1.5 text-sm font-medium disabled:opacity-40 ${adjForm.mode === m ? "bg-white text-sky-600 shadow" : "text-neutral-600"}`}>{l}</button>
                ))}
              </div>
              {adjust.stockQty === null && <p className="text-xs text-amber-600">This product is untracked — use Set to give it an opening quantity.</p>}
              <label className="block"><span className="mb-1 block font-medium">Quantity<span className="text-rose-500">*</span></span><input type="number" min={0} step="any" required autoFocus value={adjForm.qty} onChange={(e) => setAdjForm((f) => ({ ...f, qty: e.target.value }))} className="h-10 w-full rounded border border-neutral-300 px-3" /></label>
              <label className="block"><span className="mb-1 block font-medium">Reason<span className="text-rose-500">*</span></span><select value={adjForm.reason} onChange={(e) => setAdjForm((f) => ({ ...f, reason: e.target.value }))} className="h-10 w-full rounded border border-neutral-300 px-3">{REASONS.map((r) => <option key={r}>{r}</option>)}</select></label>
              <label className="block"><span className="mb-1 block font-medium">Note</span><input value={adjForm.note} onChange={(e) => setAdjForm((f) => ({ ...f, note: e.target.value }))} className="h-10 w-full rounded border border-neutral-300 px-3" /></label>
              <div className="flex justify-end gap-2 pt-2"><button type="button" onClick={() => setAdjust(null)} className="rounded bg-neutral-200 px-4 py-2">Cancel</button><button type="submit" disabled={adjusting} className="inline-flex items-center gap-2 rounded bg-sky-500 px-4 py-2 text-white disabled:opacity-60">{adjusting && <Loader2 className="h-4 w-4 animate-spin" />} Save</button></div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(history)} onOpenChange={(o) => !o && setHistory(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
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
    </div>
  )
}
