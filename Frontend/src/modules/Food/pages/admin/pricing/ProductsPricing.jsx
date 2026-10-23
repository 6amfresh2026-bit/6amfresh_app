import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Loader2, Plus, Search, Image as ImageIcon, FolderTree, Percent, ImagePlus } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@food/components/ui/dialog"

/**
 * Products & pricing — the catalogue seen through a margin lens.
 *
 * Purchase cost and selling price edit inline on each row and save straight to
 * the product; margin, demand and profit recompute from the numbers in the boxes
 * so the figures never lie about what is typed. Everything else — category, the
 * section dropdown, the photo state — is read from the same product so this is
 * one honest view, not a second copy of the price.
 */

const money = (v) => (v == null ? "—" : "₹" + Number(v).toLocaleString("en-IN"))
const marginOf = (price, cost) => {
  const p = Number(price)
  const c = Number(cost)
  if (!(p > 0) || cost === "" || cost == null || !Number.isFinite(c)) return null
  return Math.round(((p - c) / p) * 1000) / 10
}
const today = () => new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })

export default function ProductsPricing() {
  const navigate = useNavigate()
  const [items, setItems] = useState([])
  const [summary, setSummary] = useState({ products: 0, withPhotos: 0, missingPhotos: 0 })
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)

  const [search, setSearch] = useState("")
  const [debounced, setDebounced] = useState("")
  const [missingOnly, setMissingOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(25)
  const [total, setTotal] = useState(0)
  const [costFocus, setCostFocus] = useState(false)

  // Per-row unsaved cost/price edits, keyed by id → { purchaseCost, price }.
  const [draft, setDraft] = useState({})
  const [savingId, setSavingId] = useState(null)
  const [sizeRow, setSizeRow] = useState(null) // product whose sizes modal is open

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 300)
    return () => clearTimeout(id)
  }, [search])
  useEffect(() => { setPage(1) }, [debounced, missingOnly])

  useEffect(() => {
    ;(async () => {
      try {
        const res = await adminAPI.getPricingLookups()
        setCategories(res?.data?.data?.categories || [])
      } catch { /* section dropdown degrades */ }
    })()
  }, [])

  const fetchItems = useCallback(async () => {
    setLoading(true)
    try {
      const params = { page, limit: pageSize }
      if (debounced) params.search = debounced
      if (missingOnly) params.missingPhotos = true
      const res = await adminAPI.getProductPricing(params)
      const d = res?.data?.data || {}
      setItems(d.items || [])
      setTotal(Number(d.total) || 0)
      setSummary(d.summary || { products: 0, withPhotos: 0, missingPhotos: 0 })
      setDraft({})
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to load pricing")
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, debounced, missingOnly])

  useEffect(() => { fetchItems() }, [fetchItems])

  const val = (row, field) => {
    const d = draft[row.id]
    if (d && field in d) return d[field]
    const raw = field === "purchaseCost" ? row.purchaseCost : row.price
    return raw == null ? "" : String(raw)
  }
  const setVal = (row, field, v) => setDraft((p) => ({ ...p, [row.id]: { ...(p[row.id] || {}), [field]: v } }))

  const commit = async (row) => {
    const d = draft[row.id]
    if (!d) return
    const nextCost = "purchaseCost" in d ? d.purchaseCost : row.purchaseCost
    const nextPrice = "price" in d ? d.price : row.price
    const changed = Number(nextCost) !== Number(row.purchaseCost) || Number(nextPrice) !== Number(row.price)
    if (!changed) return
    setSavingId(row.id)
    try {
      const res = await adminAPI.savePricing({ itemId: row.id, purchaseCost: nextCost, price: nextPrice })
      const u = res?.data?.data || {}
      setItems((list) => list.map((it) => it.id === row.id
        ? { ...it, purchaseCost: u.purchaseCost ?? it.purchaseCost, price: u.price ?? it.price, margin: u.margin,
            profit: (u.price != null && u.purchaseCost != null) ? Math.round((u.price - u.purchaseCost) * it.demand) : null }
        : it))
      setDraft((p) => { const n = { ...p }; delete n[row.id]; return n })
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not save")
    } finally {
      setSavingId(null)
    }
  }

  const changeSection = async (row, subCategoryId) => {
    try {
      await adminAPI.savePricing({ itemId: row.id, subCategoryId })
      const name = categories.find((c) => c.id === subCategoryId)?.name || ""
      setItems((list) => list.map((it) => it.id === row.id ? { ...it, subCategoryId, subCategoryName: name } : it))
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not update section")
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const liveMargin = (row) => marginOf(val(row, "price"), val(row, "purchaseCost"))
  const liveProfit = (row) => {
    const p = Number(val(row, "price"))
    const c = Number(val(row, "purchaseCost"))
    if (!Number.isFinite(p) || !Number.isFinite(c) || val(row, "purchaseCost") === "") return null
    return Math.round((p - c) * row.demand)
  }

  return (
    <div className="min-h-screen bg-neutral-50 p-4 text-neutral-700 md:p-6">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900">Products &amp; pricing</h1>
          <p className="mt-1 text-sm text-neutral-500">Prices, purchase cost and margin · {today()}</p>
        </div>
        <button onClick={() => navigate("/admin/store/products/new")} className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90">
          <Plus className="h-4 w-4" /> New product
        </button>
      </div>

      {/* Toolbar */}
      <div className="mb-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-lg font-bold text-neutral-900">Products &amp; pricing</h2>
          <button onClick={() => setCostFocus((v) => !v)} className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium ${costFocus ? "border-primary bg-primary/10 text-primary" : "border-neutral-300 text-neutral-700 hover:border-primary hover:text-primary"}`}>
            <Percent className="h-4 w-4" /> Revise purchase prices
          </button>
          <button onClick={() => navigate("/admin/store/category-brand")} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-neutral-300 px-3 text-sm font-medium text-neutral-700 hover:border-primary hover:text-primary">
            <FolderTree className="h-4 w-4" /> Categories &amp; sub-categories
          </button>
          <button onClick={() => toast.info("Open a product to add its photos")} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-neutral-300 px-3 text-sm font-medium text-neutral-700 hover:border-primary hover:text-primary">
            <ImagePlus className="h-4 w-4" /> Bulk upload photos
          </button>
          <button onClick={() => navigate("/admin/store/products/new")} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-3 text-sm font-semibold text-white hover:opacity-90">
            <Plus className="h-4 w-4" /> Add product
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="relative min-w-[260px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search product, brand or SKU" className="h-10 w-full rounded-lg border border-neutral-300 bg-white pl-9 pr-3 text-sm text-neutral-900 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
            <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} className="h-4 w-4 accent-[color:var(--module-theme,#10b981)]" />
            Missing photos only
          </label>
          <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600">
            <ImageIcon className="h-3.5 w-3.5" /> {summary.withPhotos} of {summary.products} have photos
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="py-3 pr-3 font-medium">Photo</th>
                <th className="py-3 pr-4 font-medium">Product</th>
                <th className="py-3 pr-4 font-medium">Category</th>
                <th className="py-3 pr-4 font-medium">Sub-category</th>
                <th className="py-3 pr-4 font-medium">Section</th>
                <th className="py-3 pr-4 font-medium">Purchase cost ₹</th>
                <th className="py-3 pr-4 font-medium">Price ₹</th>
                <th className="py-3 pr-4 font-medium">Margin</th>
                <th className="py-3 pr-4 font-medium">Demand</th>
                <th className="py-3 pr-2 text-right font-medium">Profit (before discounts)</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={10} className="py-14 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-neutral-300" /></td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={10} className="py-14 text-center text-neutral-500">No products found.</td></tr>
              ) : (
                items.map((row) => {
                  const m = liveMargin(row)
                  const profit = liveProfit(row)
                  return (
                    <tr key={row.id} className="border-b border-neutral-100 align-middle hover:bg-neutral-50">
                      <td className="py-3 pr-3">
                        <div className="flex flex-col items-center gap-1">
                          <div className="h-11 w-11 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-100">
                            {row.image ? <img src={row.image} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-neutral-300"><ImageIcon className="h-5 w-5" /></div>}
                          </div>
                          <span className="text-[10px] text-neutral-400">{row.photoCount} photo{row.photoCount === 1 ? "" : "s"}</span>
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <div className="font-semibold text-neutral-900">{row.name}</div>
                        <div className="text-xs text-neutral-400">{row.unit || row.sku || "—"}</div>
                        <div className="mt-0.5 flex items-center gap-2">
                          <button onClick={() => setSizeRow(row)} className="text-xs font-medium text-primary hover:underline">+ Add another size</button>
                          <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500">{row.sizes} size{row.sizes === 1 ? "" : "s"}</span>
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-neutral-700">{row.categoryName || "—"}</td>
                      <td className="py-3 pr-4">
                        <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
                          <ImageIcon className="h-3 w-3" /> {row.photoCount}/{row.sizes}
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        <select value={row.subCategoryId || ""} onChange={(e) => changeSection(row, e.target.value)} className="h-9 max-w-[150px] rounded-lg border border-neutral-300 bg-white px-2 text-sm text-neutral-800 outline-none focus:border-primary">
                          <option value="">{row.subCategoryName || "— Section —"}</option>
                          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </td>
                      <td className="py-3 pr-4">
                        <input type="number" min={0} step="any" value={val(row, "purchaseCost")} onChange={(e) => setVal(row, "purchaseCost", e.target.value)} onBlur={() => commit(row)}
                          className={`h-9 w-24 rounded-lg border bg-white px-2 text-sm text-neutral-900 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 ${costFocus ? "border-primary/60" : "border-neutral-300"}`} />
                      </td>
                      <td className="py-3 pr-4">
                        <input type="number" min={0} step="any" value={val(row, "price")} onChange={(e) => setVal(row, "price", e.target.value)} onBlur={() => commit(row)}
                          className="h-9 w-24 rounded-lg border border-neutral-300 bg-white px-2 text-sm font-semibold text-neutral-900 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
                      </td>
                      <td className="py-3 pr-4">
                        <span className={`font-semibold ${m == null ? "text-neutral-400" : m < 10 ? "text-amber-600" : "text-primary"}`}>{m == null ? "—" : `${m}%`}</span>
                      </td>
                      <td className="py-3 pr-4 text-neutral-600">{row.demand} pcs</td>
                      <td className="py-3 pr-2 text-right font-semibold text-neutral-800">
                        {savingId === row.id ? <Loader2 className="ml-auto h-4 w-4 animate-spin text-neutral-300" /> : (profit == null ? "—" : money(profit))}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {!loading && total > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 pt-3 text-sm">
            <span className="text-neutral-500">Showing <b className="text-neutral-700">{(page - 1) * pageSize + 1}</b>–<b className="text-neutral-700">{Math.min(page * pageSize, total)}</b> of <b className="text-neutral-700">{total}</b></span>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="h-9 rounded-lg border border-neutral-300 px-3 font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40">Prev</button>
              <span className="min-w-[90px] text-center text-neutral-600">Page {page} of {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="h-9 rounded-lg border border-neutral-300 px-3 font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>

      {sizeRow && (
        <AddSizeModal
          row={sizeRow}
          onClose={() => setSizeRow(null)}
          onChanged={(res) => setItems((list) => list.map((it) => it.id === sizeRow.id ? { ...it, variants: res.variants, sizes: res.sizes } : it))}
        />
      )}
    </div>
  )
}

/** Add and review a product's pack sizes (variants) without leaving the list. */
function AddSizeModal({ row, onClose, onChanged }) {
  const [variants, setVariants] = useState(row.variants || [])
  const [name, setName] = useState("")
  const [price, setPrice] = useState("")
  const [saving, setSaving] = useState(false)

  const add = async (e) => {
    e.preventDefault()
    if (!name.trim()) return toast.error("Enter a size, e.g. 1 kg")
    if (price === "" || Number(price) < 0) return toast.error("Enter a price")
    setSaving(true)
    try {
      const res = await adminAPI.addProductSize({ itemId: row.id, name: name.trim(), price: Number(price) })
      const d = res?.data?.data || {}
      setVariants(d.variants || [])
      setName("")
      setPrice("")
      onChanged({ variants: d.variants || [], sizes: d.sizes || (d.variants?.length || 1) })
      toast.success("Size added")
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not add size")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="p-5 sm:max-w-xl sm:p-6">
        <DialogHeader>
          <DialogTitle className="text-neutral-900">Sizes · {row.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 pt-2 text-sm">
          <div className="overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50">
            <div className="flex items-center justify-between py-2.5 pl-4 pr-12 text-xs font-medium uppercase tracking-wide text-neutral-500">
              <span>Size</span><span>Price</span>
            </div>
            <div className="flex items-center justify-between border-t border-neutral-200 py-3 pl-4 pr-12">
              <span className="font-medium text-neutral-800">{row.unit || "Base"} <span className="ml-1.5 rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600">base</span></span>
              <span className="font-semibold text-neutral-800">₹{Number(row.price || 0).toLocaleString("en-IN")}</span>
            </div>
            {variants.map((v) => (
              <div key={v.id || v.name} className="flex items-center justify-between border-t border-neutral-100 py-3 pl-4 pr-12">
                <span className="text-neutral-800">{v.name}</span>
                <span className="font-semibold text-neutral-800">₹{Number(v.price || 0).toLocaleString("en-IN")}</span>
              </div>
            ))}
            {variants.length === 0 && <div className="border-t border-neutral-100 py-3 pl-4 pr-12 text-xs text-neutral-400">No extra sizes yet.</div>}
          </div>

          <form onSubmit={add} className="flex items-end gap-3 pt-1">
            <label className="flex-1">
              <span className="mb-1 block text-neutral-600">New size</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 1 kg" className="h-10 w-full rounded-lg border border-neutral-300 bg-white px-3 text-neutral-900 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
            </label>
            <label className="w-28">
              <span className="mb-1 block text-neutral-600">Price ₹</span>
              <input type="number" min={0} step="any" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" className="h-10 w-full rounded-lg border border-neutral-300 bg-white px-3 text-neutral-900 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
            </label>
            <button type="submit" disabled={saving} className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
            </button>
          </form>

          <div className="flex justify-end pt-1">
            <button type="button" onClick={onClose} className="rounded-lg border border-neutral-300 px-4 py-2 font-medium text-neutral-700 hover:bg-neutral-50">Done</button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
