import { useCallback, useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { ChevronDown, Download, FileUp, Filter, ImageIcon, Loader2, Search, Upload } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@food/components/ui/dialog"
import { canCurrentAdminAction } from "@food/utils/adminRbac"

/**
 * Product list — a replica of the reference ERP's Items > Products screen.
 *
 * Column set, toolbar and header links are the reference's, in its order:
 *   [☐] Sr. No. | Image | Item Code | Category | Brand | Name | MRP | Selling
 *   Price | HSN | Qty | Status | Show Online | Actions
 * with Import/Export · Export · page size · Filter · Search List · Create New
 * above, and "Deleted Products" / "Setup Opening Stock" top-right.
 *
 * "Setup Opening Stock" switches the Qty column into inline editing, which is
 * what that screen does in the reference: put a number in every row without
 * opening each product.
 */

const STOCK_BADGE = {
  low: "bg-amber-100 text-amber-800",
  critical: "bg-orange-100 text-orange-900",
  out: "bg-rose-100 text-rose-800",
}

const PAGE_SIZES = [10, 25, 50, 100]
const money = (n) => (n === null || n === undefined || n === "" ? "" : Number(n).toFixed(1))

export default function ProductsList() {
  const navigate = useNavigate()
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [selected, setSelected] = useState(() => new Set())
  const [menuFor, setMenuFor] = useState(null)
  const [openingStock, setOpeningStock] = useState(false)
  const [stockDraft, setStockDraft] = useState({})

  // Filter popover
  const [filterOpen, setFilterOpen] = useState(false)
  const [filters, setFilters] = useState({ restaurantId: "", categoryId: "", brandId: "", status: "", showOnline: "" })
  const [applied, setApplied] = useState(filters)
  const [restaurants, setRestaurants] = useState([])
  const [categories, setCategories] = useState([])
  const [brands, setBrands] = useState([])

  // Import/Export
  const [importOpen, setImportOpen] = useState(false)
  const [importStore, setImportStore] = useState("")
  const [importFile, setImportFile] = useState(null)
  const [importing, setImporting] = useState(false)
  const [ieMenu, setIeMenu] = useState(false)
  const [exportMenu, setExportMenu] = useState(false)
  const fileRef = useRef(null)

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const canCreate = canCurrentAdminAction("create", "/admin/store/products")
  const canEdit = canCurrentAdminAction("edit", "/admin/store/products")
  const canDelete = canCurrentAdminAction("delete", "/admin/store/products")

  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPage(1)
    }, 300)
    return () => window.clearTimeout(id)
  }, [search])

  useEffect(() => {
    // Lookups for the Filter popover and the import store picker.
    ;(async () => {
      try {
        const [r, c, b] = await Promise.all([
          adminAPI.getRestaurants({ limit: 1000 }),
          adminAPI.getCategories({ limit: 1000 }),
          adminAPI.getBrands({ limit: 200 }),
        ])
        setRestaurants(r?.data?.data?.restaurants || r?.data?.restaurants || [])
        const cats = c?.data?.data?.categories || c?.data?.data || []
        setCategories(Array.isArray(cats) ? cats : [])
        setBrands(b?.data?.data?.brands || [])
      } catch {
        /* filters still work as free text search */
      }
    })()
  }, [])

  const fetchRows = useCallback(async () => {
    setLoading(true)
    try {
      const params = { page, limit: pageSize }
      if (debouncedSearch) params.search = debouncedSearch
      Object.entries(applied).forEach(([k, v]) => {
        if (v) params[k] = v
      })
      const res = await adminAPI.getFoods(params)
      const data = res?.data?.data || {}
      setRows(data.foods || [])
      setTotal(Number(data.total) || 0)
      setSelected(new Set())
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to load products")
      setRows([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, debouncedSearch, applied])

  useEffect(() => {
    fetchRows()
  }, [fetchRows])

  const toggleShowOnline = async (row) => {
    try {
      await adminAPI.toggleFoodShowOnline(row.id)
      setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, showOnline: !r.showOnline } : r)))
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not update")
    }
  }

  const toggleStatus = async (row) => {
    try {
      await adminAPI.updateFood(row.id, { isAvailable: !row.isAvailable })
      setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, isAvailable: !r.isAvailable } : r)))
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not update")
    }
  }

  const onDelete = async (row) => {
    setMenuFor(null)
    if (!window.confirm(`Move "${row.name}" to Deleted Products?`)) return
    try {
      await adminAPI.deleteFood(row.id)
      toast.success("Product moved to Deleted Products")
      fetchRows()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Delete failed")
    }
  }

  const saveStock = async (row) => {
    const raw = stockDraft[row.id]
    if (raw === undefined) return
    const qty = raw === "" ? null : Number(raw)
    if (qty !== null && (!Number.isFinite(qty) || qty < 0)) {
      toast.error("Qty must be 0 or more")
      return
    }
    try {
      await adminAPI.updateFood(row.id, { stockQty: qty })
      setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, stockQty: qty } : r)))
      setStockDraft((d) => {
        const n = { ...d }
        delete n[row.id]
        return n
      })
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not save qty")
    }
  }

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
  const toggleOne = (id) =>
    setSelected((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  const exportCsv = (onlySelected) => {
    setExportMenu(false)
    const list = onlySelected ? rows.filter((r) => selected.has(r.id)) : rows
    if (!list.length) return toast.error("Nothing to export")
    const head = ["Item Code", "Category", "Brand", "Name", "MRP", "Selling Price", "HSN", "Qty", "Status", "Show Online"]
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`
    const lines = list.map((r) =>
      [r.itemCode, r.categoryName, r.brandName, r.name, r.mrp ?? "", r.price ?? "", r.hsnCode, r.stockQty ?? "", r.isAvailable ? "ACTIVE" : "INACTIVE", r.showOnline ? "Yes" : "No"].map(esc).join(",")
    )
    const blob = new Blob([[head.map(esc).join(","), ...lines].join("\n")], { type: "text/csv" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `products-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const downloadTemplate = async () => {
    setIeMenu(false)
    try {
      const res = await adminAPI.bulkUploadTemplate()
      const blob = new Blob([res.data], { type: res.headers?.["content-type"] || "application/octet-stream" })
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = "product-import-template.xlsx"
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not download template")
    }
  }

  const runImport = async () => {
    if (!importStore) return toast.error("Select a store")
    if (!importFile) return toast.error("Choose a file")
    setImporting(true)
    try {
      const res = await adminAPI.bulkUploadFoods(importStore, importFile)
      toast.success(res?.data?.message || "Import complete")
      setImportOpen(false)
      setImportFile(null)
      fetchRows()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Import failed")
    } finally {
      setImporting(false)
    }
  }

  const applyFilters = () => {
    setApplied(filters)
    setPage(1)
    setFilterOpen(false)
  }
  const clearFilters = () => {
    const empty = { restaurantId: "", categoryId: "", brandId: "", status: "", showOnline: "" }
    setFilters(empty)
    setApplied(empty)
    setPage(1)
    setFilterOpen(false)
  }
  const activeFilterCount = Object.values(applied).filter(Boolean).length

  return (
    <div className="p-4 sm:p-6">
      {/* Header: title + home crumb, right links */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-lg">
          <span className="font-semibold text-neutral-900">Product</span>
          <span className="text-neutral-300">|</span>
          <span className="text-neutral-400">⌂</span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Link to="/admin/store/products/deleted" className="text-sky-600 hover:underline">Deleted Products</Link>
          <button
            type="button"
            onClick={() => setOpeningStock((v) => !v)}
            className={`hover:underline ${openingStock ? "font-semibold text-sky-700" : "text-sky-600"}`}
          >
            Setup Opening Stock
          </button>
        </div>
      </div>

      <div className="rounded-md border border-neutral-200 bg-white p-4 shadow-sm">
        {/* Toolbar */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative">
            <button type="button" onClick={() => setIeMenu((v) => !v)} className="inline-flex h-9 items-center gap-2 rounded bg-sky-500 px-3 text-sm font-medium text-white hover:bg-sky-600">
              <FileUp className="h-4 w-4" /> Import/Export <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {ieMenu && (
              <div className="absolute z-20 mt-1 w-48 rounded border border-neutral-200 bg-white py-1 text-sm shadow-lg">
                <button type="button" onClick={downloadTemplate} className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-neutral-50"><Download className="h-3.5 w-3.5" /> Download Template</button>
                <button type="button" onClick={() => { setIeMenu(false); setImportOpen(true) }} className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-neutral-50"><Upload className="h-3.5 w-3.5" /> Import Products</button>
              </div>
            )}
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative">
              <button type="button" onClick={() => setExportMenu((v) => !v)} className="inline-flex h-9 items-center gap-2 rounded bg-sky-500 px-3 text-sm font-medium text-white hover:bg-sky-600">
                <Download className="h-4 w-4" /> Export <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {exportMenu && (
                <div className="absolute right-0 z-20 mt-1 w-44 rounded border border-neutral-200 bg-white py-1 text-sm shadow-lg">
                  <button type="button" onClick={() => exportCsv(false)} className="block w-full px-3 py-1.5 text-left hover:bg-neutral-50">This page (CSV)</button>
                  <button type="button" onClick={() => exportCsv(true)} className="block w-full px-3 py-1.5 text-left hover:bg-neutral-50">Selected (CSV)</button>
                </div>
              )}
            </div>

            <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }} className="h-9 rounded border border-neutral-300 bg-white px-2 text-sm">
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>

            <div className="relative">
              <button type="button" onClick={() => setFilterOpen((v) => !v)} className="inline-flex h-9 items-center gap-2 rounded bg-sky-500 px-3 text-sm font-medium text-white hover:bg-sky-600">
                <Filter className="h-4 w-4" /> Filter{activeFilterCount ? ` (${activeFilterCount})` : ""}
              </button>
              {filterOpen && (
                <div className="absolute right-0 z-20 mt-1 w-72 space-y-2 rounded border border-neutral-200 bg-white p-3 text-sm shadow-lg">
                  <select value={filters.restaurantId} onChange={(e) => setFilters((f) => ({ ...f, restaurantId: e.target.value }))} className="w-full rounded border border-neutral-300 px-2 py-1.5">
                    <option value="">All Stores</option>
                    {restaurants.map((r) => <option key={r._id || r.id} value={r._id || r.id}>{r.restaurantName || r.name}</option>)}
                  </select>
                  <select value={filters.categoryId} onChange={(e) => setFilters((f) => ({ ...f, categoryId: e.target.value }))} className="w-full rounded border border-neutral-300 px-2 py-1.5">
                    <option value="">All Categories</option>
                    {categories.map((c) => <option key={c._id || c.id} value={c._id || c.id}>{c.name}</option>)}
                  </select>
                  <select value={filters.brandId} onChange={(e) => setFilters((f) => ({ ...f, brandId: e.target.value }))} className="w-full rounded border border-neutral-300 px-2 py-1.5">
                    <option value="">All Brands</option>
                    {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                  <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} className="w-full rounded border border-neutral-300 px-2 py-1.5">
                    <option value="">Any Status</option>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                  <select value={filters.showOnline} onChange={(e) => setFilters((f) => ({ ...f, showOnline: e.target.value }))} className="w-full rounded border border-neutral-300 px-2 py-1.5">
                    <option value="">Show Online: Any</option>
                    <option value="true">Show Online: Yes</option>
                    <option value="false">Show Online: No</option>
                  </select>
                  <div className="flex justify-end gap-2 pt-1">
                    <button type="button" onClick={clearFilters} className="rounded bg-neutral-200 px-3 py-1.5">Clear</button>
                    <button type="button" onClick={applyFilters} className="rounded bg-sky-500 px-3 py-1.5 text-white">Apply</button>
                  </div>
                </div>
              )}
            </div>

            <div className="relative">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search List..." className="h-9 w-52 rounded border border-neutral-300 bg-white pl-3 pr-8 text-sm outline-none focus:border-sky-500" />
              <Search className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            </div>

            {canCreate && (
              <button type="button" onClick={() => navigate("/admin/store/products/new")} className="h-9 rounded bg-sky-500 px-4 text-sm font-medium text-white hover:bg-sky-600">
                Create New
              </button>
            )}
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-sm">
            <thead className="bg-neutral-100 text-left text-neutral-800">
              <tr>
                <th className="w-8 px-3 py-3"><input type="checkbox" checked={allSelected} onChange={toggleAll} className="rounded border-neutral-300" /></th>
                <th className="px-3 py-3 font-semibold">Sr. No.</th>
                <th className="px-3 py-3 font-semibold">Image</th>
                <th className="px-3 py-3 font-semibold">Item Code</th>
                <th className="px-3 py-3 font-semibold">Category</th>
                <th className="px-3 py-3 font-semibold">Brand</th>
                <th className="px-3 py-3 font-semibold">Name</th>
                <th className="px-3 py-3 font-semibold">MRP</th>
                <th className="px-3 py-3 font-semibold">Selling Price</th>
                <th className="px-3 py-3 font-semibold">HSN</th>
                <th className="px-3 py-3 font-semibold">Qty</th>
                <th className="px-3 py-3 font-semibold">Status</th>
                <th className="px-3 py-3 font-semibold">Show Online</th>
                <th className="px-3 py-3 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={14} className="px-3 py-14 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-neutral-400" /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={14} className="px-3 py-14 text-center text-neutral-500">No products found.</td></tr>
              ) : (
                rows.map((row, i) => (
                  <tr key={row.id} className="border-t border-neutral-100 odd:bg-white even:bg-neutral-50/60">
                    <td className="px-3 py-3"><input type="checkbox" checked={selected.has(row.id)} onChange={() => toggleOne(row.id)} className="rounded border-neutral-300" /></td>
                    <td className="px-3 py-3 text-sky-600">{(page - 1) * pageSize + i + 1}</td>
                    <td className="px-3 py-2">
                      <div className="grid h-14 w-14 place-items-center overflow-hidden rounded border border-neutral-200 bg-white">
                        {row.image ? <img src={row.image} alt="" className="h-full w-full object-cover" /> : <ImageIcon className="h-5 w-5 text-neutral-300" />}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-neutral-700">{row.itemCode || "—"}</td>
                    <td className="px-3 py-3 text-neutral-700">{row.categoryName || "—"}</td>
                    <td className="px-3 py-3 text-neutral-700">{row.brandName || "—"}</td>
                    <td className="px-3 py-3">
                      <Link to={`/admin/store/products/${row.id}/edit`} className="font-medium text-sky-600 hover:underline">{row.name}</Link>
                    </td>
                    <td className="px-3 py-3 text-neutral-700">{money(row.mrp)}</td>
                    <td className="px-3 py-3 text-neutral-700">{money(row.price)}</td>
                    <td className="px-3 py-3 text-neutral-700">{row.hsnCode || ""}</td>
                    <td className="px-3 py-3 text-neutral-700">
                      {openingStock && canEdit ? (
                        <input
                          type="number"
                          min={0}
                          value={stockDraft[row.id] ?? (row.stockQty ?? "")}
                          onChange={(e) => setStockDraft((d) => ({ ...d, [row.id]: e.target.value }))}
                          onBlur={() => saveStock(row)}
                          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                          className="w-20 rounded border border-sky-400 px-2 py-1 text-sm"
                        />
                      ) : (
                        <div className="flex flex-col gap-1">
                          <span>
                            {row.stockQty === null || row.stockQty === undefined
                              ? "0.00"
                              : Number(row.stockQty).toFixed(2)}
                          </span>
                          {/* The badge carries the number as well as the word:
                              "Low stock" alone says nothing about what to
                              reorder. Computed on the server so this cell can
                              never disagree with the stock screen. */}
                          {row.stockBadge?.needsAttention && (
                            <span
                              className={`inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                                STOCK_BADGE[row.stockBadge.tier] || STOCK_BADGE.low
                              }`}
                            >
                              ⚠️ {row.stockBadge.label}
                              {row.stockBadge.tier !== "out" && ` · ${row.stockBadge.remaining} left`}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <button type="button" disabled={!canEdit} onClick={() => toggleStatus(row)} className={`rounded px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-white ${row.isAvailable ? "bg-emerald-500" : "bg-neutral-400"}`}>
                        {row.isAvailable ? "Active" : "Inactive"}
                      </button>
                    </td>
                    <td className="px-3 py-3">
                      <button
                        type="button"
                        disabled={!canEdit}
                        onClick={() => toggleShowOnline(row)}
                        role="switch"
                        aria-checked={row.showOnline}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${row.showOnline ? "bg-sky-500" : "bg-neutral-200"}`}
                      >
                        <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition ${row.showOnline ? "translate-x-5" : "translate-x-0.5"}`} />
                      </button>
                    </td>
                    <td className="relative px-3 py-3">
                      <button type="button" onClick={() => setMenuFor(menuFor === row.id ? null : row.id)} className="px-2 text-lg leading-none text-neutral-500 hover:text-neutral-800" aria-label="Actions">···</button>
                      {menuFor === row.id && (
                        <div className="absolute right-2 z-10 mt-1 w-32 rounded border border-neutral-200 bg-white py-1 text-sm shadow-lg">
                          {canEdit && <button type="button" onClick={() => navigate(`/admin/store/products/${row.id}/edit`)} className="block w-full px-3 py-1.5 text-left hover:bg-neutral-50">Edit</button>}
                          {canDelete && <button type="button" onClick={() => onDelete(row)} className="block w-full px-3 py-1.5 text-left text-rose-600 hover:bg-rose-50">Delete</button>}
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center justify-between text-sm text-neutral-600">
          <span>Showing {rows.length ? (page - 1) * pageSize + 1 : 0} to {(page - 1) * pageSize + rows.length} of {total}</span>
          <div className="flex items-center gap-2">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border border-neutral-300 px-3 py-1 disabled:opacity-40">Prev</button>
            <span>{page} / {totalPages}</span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded border border-neutral-300 px-3 py-1 disabled:opacity-40">Next</button>
          </div>
        </div>
      </div>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-sky-600">Import Products</DialogTitle></DialogHeader>
          <div className="space-y-3 text-sm">
            <label className="block">
              <span className="mb-1 block font-medium">Store<span className="text-rose-500">*</span></span>
              <select value={importStore} onChange={(e) => setImportStore(e.target.value)} className="w-full rounded border border-neutral-300 px-3 py-2">
                <option value="">Select Store</option>
                {restaurants.map((r) => <option key={r._id || r.id} value={r._id || r.id}>{r.restaurantName || r.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block font-medium">File (template format)<span className="text-rose-500">*</span></span>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setImportFile(e.target.files?.[0] || null)} className="w-full text-sm" />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setImportOpen(false)} className="rounded bg-neutral-200 px-4 py-2">Cancel</button>
              <button type="button" disabled={importing} onClick={runImport} className="inline-flex items-center gap-2 rounded bg-sky-500 px-4 py-2 text-white disabled:opacity-60">
                {importing && <Loader2 className="h-4 w-4 animate-spin" />} Import
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
