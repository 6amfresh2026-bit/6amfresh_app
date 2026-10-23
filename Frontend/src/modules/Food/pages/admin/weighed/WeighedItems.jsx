import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2, Plus, Scale, Percent, AlertTriangle, Store, Leaf, Minus, Equal, Package } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@food/components/ui/dialog"

/**
 * Weighed items & rates — loose vegetables and fruit sold by the kilogram at the
 * store counters.
 *
 * One row is one product across every store: the per-kg rate, an optional
 * under-500 g rate and the cost sit on the left as editable boxes; the per-store
 * stock sits on the right as chips. Typing new rates marks a row dirty; Publish
 * writes every dirty row to all of that product's store copies at once, which is
 * what puts the price live on the POS. Stock is never edited inline — the chip's
 * store opens the same ledger-backed adjust the Stocks screen uses.
 */

const num = (v) => Number(v || 0).toFixed(2)
// Trailing-zero-free kg, so "9.883 kg" and "50 kg" both read cleanly.
const kg = (v) => {
  const n = Number(v || 0)
  return (Number.isInteger(n) ? n.toString() : n.toFixed(3).replace(/\.?0+$/, "")) + " kg"
}
const when = (d) =>
  d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"
const marginOf = (rate, cost) => {
  const r = Number(rate)
  const c = Number(cost)
  if (!(r > 0) || cost === "" || cost == null || !Number.isFinite(c)) return null
  return Math.round(((r - c) / r) * 100)
}
const ADJ_REASONS = ["Purchase received", "Damaged", "Counting correction", "Wastage", "Other"]

export default function WeighedItems() {
  const [stores, setStores] = useState([])
  const [storeId, setStoreId] = useState("")
  const [items, setItems] = useState([])
  const [summary, setSummary] = useState({ looseItems: 0, avgMargin: 0, lowStock: 0, under500: 0, storesShowing: 0 })
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)

  // Per-row unsaved edits, keyed by row.key → { rate, smallQtyRate, cost } (strings).
  const [draft, setDraft] = useState({})
  const [costFocus, setCostFocus] = useState(false)
  const costRef = useRef(null)

  const [editItem, setEditItem] = useState(null) // row being edited, or {} for a new item
  const [stockRow, setStockRow] = useState(null) // row whose per-store stock is open

  useEffect(() => {
    ;(async () => {
      try {
        const r = await adminAPI.getRestaurants({ limit: 1000 })
        setStores(r?.data?.data?.restaurants || r?.data?.restaurants || [])
      } catch {
        /* store filter degrades to "All stores" */
      }
    })()
  }, [])

  const fetchItems = useCallback(async () => {
    setLoading(true)
    try {
      const params = {}
      if (storeId) params.restaurantId = storeId
      const res = await adminAPI.getWeighedItems(params)
      const d = res?.data?.data || {}
      setItems(d.items || [])
      setSummary(d.summary || { looseItems: 0, avgMargin: 0, lowStock: 0, under500: 0, storesShowing: 0 })
      setDraft({})
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to load weighed items")
    } finally {
      setLoading(false)
    }
  }, [storeId])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  // A row's current values: the draft if touched, else what the server sent.
  const valueOf = useCallback(
    (row, field) => {
      const d = draft[row.key]
      if (d && field in d) return d[field]
      const raw = field === "rate" ? row.rate : field === "smallQtyRate" ? row.smallQtyRate : row.cost
      return raw == null ? "" : String(raw)
    },
    [draft]
  )
  const setValue = (row, field, v) =>
    setDraft((p) => ({ ...p, [row.key]: { ...(p[row.key] || {}), [field]: v } }))

  const dirtyRows = useMemo(
    () =>
      items.filter((row) => {
        const d = draft[row.key]
        if (!d) return false
        const same = (field, raw) => {
          if (!(field in d)) return true
          const a = d[field] === "" ? null : Number(d[field])
          const b = raw == null ? null : Number(raw)
          return a === b
        }
        return !(same("rate", row.rate) && same("smallQtyRate", row.smallQtyRate) && same("cost", row.cost))
      }),
    [items, draft]
  )

  const publish = async () => {
    if (dirtyRows.length === 0) {
      toast.info("No rate changes to publish")
      return
    }
    setPublishing(true)
    try {
      const rates = dirtyRows.map((row) => ({
        name: row.name,
        rate: valueOf(row, "rate"),
        smallQtyRate: valueOf(row, "smallQtyRate"),
        cost: valueOf(row, "cost"),
      }))
      const res = await adminAPI.publishWeighedRates({ rates, ...(storeId ? { restaurantId: storeId } : {}) })
      const d = res?.data?.data || {}
      toast.success(`Published ${d.groups || rates.length} item${(d.groups || rates.length) === 1 ? "" : "s"} — live on the POS`)
      fetchItems()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Publish failed")
    } finally {
      setPublishing(false)
    }
  }

  const reviseCosts = () => {
    setCostFocus(true)
    setTimeout(() => costRef.current?.focus(), 50)
  }

  const KPIS = [
    { Icon: Leaf, tint: "text-primary", label: "Loose items", value: summary.looseItems, sub: "sold by weight" },
    { Icon: Percent, tint: "text-amber-500", label: "Average margin", value: `${summary.avgMargin}%`, sub: "on today's rates" },
    { Icon: AlertTriangle, tint: "text-amber-500", label: "Low stock", value: summary.lowStock, sub: "items under 5 kg in a store" },
    { Icon: Scale, tint: "text-sky-500", label: "Under 500 g rate", value: summary.under500, sub: "items with a small-quantity rate" },
    { Icon: Store, tint: "text-primary", label: "Stores", value: summary.storesShowing, sub: "showing stock" },
  ]

  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })

  return (
    <div className="min-h-screen bg-neutral-50 p-4 text-neutral-700 md:p-6">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900">Weighed items &amp; rates</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Vegetables and fruit sold by weight: rates, stores and stock · {today}
          </p>
        </div>
        <button
          onClick={() => setEditItem({})}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> New product
        </button>
      </div>

      {/* Panel */}
      <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-5">
        <h2 className="text-lg font-bold text-neutral-900">Weighed items &amp; rates</h2>
        <p className="mt-1 max-w-3xl text-sm text-neutral-500">
          Vegetables and fruit sold loose by weight at the store counters. Set the rate for 1 kg and an optional rate for
          small quantities under 500 g. Rates go live in the POS the moment you publish.
        </p>

        {/* Controls */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
            className="h-10 rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-800 outline-none focus:border-primary"
          >
            <option value="">All stores</option>
            {stores.map((s) => (
              <option key={s._id || s.id} value={s._id || s.id}>
                {s.restaurantName || s.name}
              </option>
            ))}
          </select>
          <button
            onClick={reviseCosts}
            className="inline-flex h-10 items-center gap-2 rounded-full border border-neutral-300 px-4 text-sm font-medium text-neutral-700 hover:border-primary hover:text-primary"
          >
            <Percent className="h-4 w-4" /> Revise costs
          </button>
          <button
            onClick={() => setEditItem({})}
            className="inline-flex h-10 items-center gap-2 rounded-full border border-neutral-300 px-4 text-sm font-medium text-neutral-700 hover:border-primary hover:text-primary"
          >
            <Plus className="h-4 w-4" /> Add item
          </button>
          <button
            onClick={publish}
            disabled={publishing}
            className="ml-auto inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-50"
          >
            {publishing && <Loader2 className="h-4 w-4 animate-spin" />}
            Publish rates{dirtyRows.length > 0 ? ` · ${dirtyRows.length}` : ""}
          </button>
        </div>

        {/* KPI tiles */}
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          {KPIS.map((k) => (
            <div key={k.label} className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-neutral-500">
                <k.Icon className={`h-4 w-4 ${k.tint}`} /> {k.label}
              </div>
              <div className="mt-2 text-2xl font-bold text-neutral-900">{k.value}</div>
              <div className="mt-0.5 text-xs text-neutral-400">{k.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Rate list */}
      <div className="mt-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-5">
        <h2 className="text-lg font-bold text-neutral-900">Rate list</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Type new rates in the boxes, then press Publish. ₹ per kg. Leave &quot;under 500 g&quot; empty to use the same
          rate for every weight.
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[920px] text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="py-3 pr-4 font-medium">Item</th>
                <th className="py-3 pr-4 font-medium">Rate · 1 kg</th>
                <th className="py-3 pr-4 font-medium">Under 500 g · per kg</th>
                <th className="py-3 pr-4 font-medium">Cost · per kg</th>
                <th className="py-3 pr-4 font-medium">Margin</th>
                <th className="py-3 pr-4 font-medium">Stock (kg)</th>
                <th className="py-3 pr-4 font-medium">Updated</th>
                <th className="py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-14 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-neutral-300" />
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-14 text-center text-neutral-500">
                    No weighed items yet. Use <b className="text-neutral-700">Add item</b> to sell produce by weight.
                  </td>
                </tr>
              ) : (
                items.map((row, i) => {
                  const m = marginOf(valueOf(row, "rate"), valueOf(row, "cost"))
                  const isDirty = dirtyRows.includes(row)
                  return (
                    <tr key={row.key} className="border-b border-neutral-100 align-middle hover:bg-neutral-50">
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2">
                          <span className="text-lg">{foodEmoji(row.name)}</span>
                          <div>
                            <div className="font-semibold text-neutral-900">
                              {row.name}
                              {isDirty && <span className="ml-2 align-middle text-[10px] font-semibold text-amber-600">● unsaved</span>}
                            </div>
                            <div className="text-xs text-neutral-400">{row.categoryName || "Produce"}</div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <RateInput value={valueOf(row, "rate")} onChange={(v) => setValue(row, "rate", v)} />
                      </td>
                      <td className="py-3 pr-4">
                        <RateInput
                          value={valueOf(row, "smallQtyRate")}
                          placeholder="—"
                          onChange={(v) => setValue(row, "smallQtyRate", v)}
                        />
                      </td>
                      <td className="py-3 pr-4">
                        <RateInput
                          ref={i === 0 ? costRef : null}
                          value={valueOf(row, "cost")}
                          onChange={(v) => setValue(row, "cost", v)}
                          highlight={costFocus}
                        />
                      </td>
                      <td className="py-3 pr-4">
                        <span className={`font-semibold ${m == null ? "text-neutral-400" : m < 15 ? "text-amber-600" : "text-primary"}`}>
                          {m == null ? "—" : `${m}%`}
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        <div className="flex flex-wrap gap-1.5">
                          {row.stores.map((s) => (
                            <button
                              key={s.itemId}
                              onClick={() => setStockRow(row)}
                              title={`Adjust stock · ${s.restaurantName}`}
                              className={`rounded-md px-2 py-1 text-xs font-medium ${
                                !s.on
                                  ? "bg-rose-50 text-rose-600"
                                  : s.stockKg < 5
                                  ? "bg-amber-50 text-amber-700"
                                  : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
                              }`}
                            >
                              {s.restaurantName} {s.on ? kg(s.stockKg) : "off"}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-xs text-neutral-400">{when(row.updatedAt)}</td>
                      <td className="py-3">
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => setStockRow(row)}
                            className="rounded-full border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:border-primary hover:text-primary"
                          >
                            Stock
                          </button>
                          <button
                            onClick={() => setEditItem(row)}
                            className="rounded-full border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-700 hover:border-primary hover:text-primary"
                          >
                            Edit
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editItem && (
        <EditItemModal
          row={editItem}
          stores={stores}
          onClose={() => setEditItem(null)}
          onSaved={() => {
            setEditItem(null)
            fetchItems()
          }}
        />
      )}
      {stockRow && (
        <StockModal
          row={stockRow}
          onClose={() => setStockRow(null)}
          onSaved={() => {
            setStockRow(null)
            fetchItems()
          }}
        />
      )}
    </div>
  )
}

/** A naive produce emoji so the counter list reads at a glance; falls back to a leaf. */
function foodEmoji(name = "") {
  const n = name.toLowerCase()
  const map = [
    ["tomato", "🍅"], ["onion", "🧅"], ["potato", "🥔"], ["okra", "🫑"], ["bhindi", "🫑"],
    ["spinach", "🥬"], ["palak", "🥬"], ["cauliflower", "🥦"], ["broccoli", "🥦"], ["carrot", "🥕"],
    ["chilli", "🌶️"], ["pepper", "🫑"], ["cucumber", "🥒"], ["corn", "🌽"], ["garlic", "🧄"],
    ["apple", "🍎"], ["banana", "🍌"], ["mango", "🥭"], ["grape", "🍇"], ["lemon", "🍋"],
  ]
  for (const [k, e] of map) if (n.includes(k)) return e
  return "🥬"
}

const RateInput = forwardRef(function RateInput({ value, onChange, placeholder = "0", highlight = false }, ref) {
  return (
    <div className="relative w-28">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-neutral-400">₹</span>
      <input
        ref={ref}
        type="number"
        min={0}
        step="any"
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`h-10 w-full rounded-lg border bg-white pl-6 pr-2 text-sm text-neutral-900 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 ${
          highlight ? "border-primary/60" : "border-neutral-300"
        }`}
      />
    </div>
  )
})

/** Create a new weighed product, or edit an existing group's rates and category. */
function EditItemModal({ row, stores, onClose, onSaved }) {
  const isNew = !row?.name
  const [form, setForm] = useState({
    name: row?.name || "",
    categoryName: row?.categoryName || "",
    foodType: row?.foodType || "Veg",
    rate: row?.rate ?? "",
    smallQtyRate: row?.smallQtyRate ?? "",
    cost: row?.cost ?? "",
    restaurantIds: isNew ? [] : (row?.stores || []).map((s) => s.restaurantId),
  })
  const [saving, setSaving] = useState(false)

  const toggleStore = (id) =>
    setForm((f) => ({
      ...f,
      restaurantIds: f.restaurantIds.includes(id) ? f.restaurantIds.filter((x) => x !== id) : [...f.restaurantIds, id],
    }))

  const submit = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) return toast.error("Name is required")
    if (form.rate === "" || Number(form.rate) < 0) return toast.error("A 1 kg rate is required")
    setSaving(true)
    try {
      await adminAPI.addWeighedItem({
        name: form.name.trim(),
        categoryName: form.categoryName.trim(),
        foodType: form.foodType,
        rate: Number(form.rate),
        smallQtyRate: form.smallQtyRate === "" ? null : Number(form.smallQtyRate),
        cost: form.cost === "" ? null : Number(form.cost),
        restaurantIds: form.restaurantIds,
      })
      toast.success(isNew ? "Weighed item added" : "Item updated")
      onSaved()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Save failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="p-5 sm:max-w-md sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-neutral-900">
            <Scale className="h-5 w-5 text-primary" /> {isNew ? "Add weighed item" : `Edit ${row.name}`}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-neutral-600">Item name</span>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              disabled={!isNew}
              placeholder="Tomato"
              className="h-10 w-full rounded-lg border border-neutral-300 bg-white px-3 text-neutral-900 outline-none focus:border-primary disabled:bg-neutral-100 disabled:text-neutral-500"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-neutral-600">Category</span>
              <input
                value={form.categoryName}
                onChange={(e) => setForm((f) => ({ ...f, categoryName: e.target.value }))}
                placeholder="Vegetables"
                className="h-10 w-full rounded-lg border border-neutral-300 bg-white px-3 text-neutral-900 outline-none focus:border-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-600">Type</span>
              <select
                value={form.foodType}
                onChange={(e) => setForm((f) => ({ ...f, foodType: e.target.value }))}
                className="h-10 w-full rounded-lg border border-neutral-300 bg-white px-3 text-neutral-900 outline-none focus:border-primary"
              >
                <option>Veg</option>
                <option>Non-Veg</option>
              </select>
            </label>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="mb-1 block text-neutral-600">Rate · 1 kg</span>
              <input type="number" min={0} step="any" value={form.rate} onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))} className="h-10 w-full rounded-lg border border-neutral-300 bg-white px-3 text-neutral-900 outline-none focus:border-primary" />
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-600">Under 500 g</span>
              <input type="number" min={0} step="any" value={form.smallQtyRate} onChange={(e) => setForm((f) => ({ ...f, smallQtyRate: e.target.value }))} placeholder="—" className="h-10 w-full rounded-lg border border-neutral-300 bg-white px-3 text-neutral-900 outline-none focus:border-primary" />
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-600">Cost · kg</span>
              <input type="number" min={0} step="any" value={form.cost} onChange={(e) => setForm((f) => ({ ...f, cost: e.target.value }))} className="h-10 w-full rounded-lg border border-neutral-300 bg-white px-3 text-neutral-900 outline-none focus:border-primary" />
            </label>
          </div>
          <div>
            <span className="mb-1.5 block text-neutral-600">{isNew ? "Add to stores" : "Stores"}</span>
            <div className="flex flex-wrap gap-1.5">
              {stores.map((s) => {
                const id = String(s._id || s.id)
                const on = form.restaurantIds.includes(id)
                return (
                  <button
                    type="button"
                    key={id}
                    onClick={() => toggleStore(id)}
                    className={`rounded-full border px-3 py-1.5 text-xs ${on ? "border-primary bg-primary/10 text-primary" : "border-neutral-300 text-neutral-500"}`}
                  >
                    {s.restaurantName || s.name}
                  </button>
                )
              })}
            </div>
            {isNew && form.restaurantIds.length === 0 && (
              <p className="mt-1 text-xs text-neutral-400">None selected — the item is added to every store.</p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded-lg border border-neutral-300 px-4 py-2 font-medium text-neutral-700 hover:bg-neutral-50">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2 font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} {isNew ? "Add item" : "Save"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Per-store stock for one weighed item — each store opens an add/remove/set adjust. */
function StockModal({ row, onClose, onSaved }) {
  const [editing, setEditing] = useState(null) // store member being adjusted
  const [form, setForm] = useState({ mode: "add", qty: "", reason: ADJ_REASONS[0] })
  const [saving, setSaving] = useState(false)

  const openStore = (s) => {
    setForm({ mode: s.tracked ? "add" : "set", qty: "", reason: ADJ_REASONS[0] })
    setEditing(s)
  }

  const submit = async (e) => {
    e.preventDefault()
    const q = Number(form.qty)
    if (!(q >= 0)) return toast.error("Enter a quantity")
    setSaving(true)
    try {
      await adminAPI.adjustStock({ itemId: editing.itemId, mode: form.mode, qty: q, reason: form.reason, note: "Weighed counter" })
      toast.success(`${row.name} · ${editing.restaurantName} updated`)
      onSaved()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Adjustment failed")
    } finally {
      setSaving(false)
    }
  }

  const MODES = [
    { m: "add", label: "Add", Icon: Plus },
    { m: "remove", label: "Remove", Icon: Minus },
    { m: "set", label: "Set", Icon: Equal },
  ]

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="p-5 sm:max-w-md sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-neutral-900">
            <Package className="h-5 w-5 text-primary" /> Stock · {row.name}
          </DialogTitle>
        </DialogHeader>

        {!editing ? (
          <div className="space-y-2 text-sm">
            <p className="text-neutral-500">Pick a store to adjust its counter stock (kg).</p>
            {row.stores.map((s) => (
              <button
                key={s.itemId}
                onClick={() => openStore(s)}
                className="flex w-full items-center justify-between rounded-lg border border-neutral-200 bg-white px-4 py-3 text-left hover:border-primary"
              >
                <span className="font-medium text-neutral-900">{s.restaurantName}</span>
                <span className={`text-sm font-semibold ${!s.on ? "text-rose-600" : s.stockKg < 5 ? "text-amber-600" : "text-primary"}`}>
                  {s.on ? kg(s.stockKg) : "off"}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4 text-sm">
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
              <div className="text-neutral-500">{editing.restaurantName}</div>
              <div className="text-xl font-bold text-neutral-900">{editing.on ? kg(editing.stockKg) : "off"}</div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {MODES.map(({ m, label, Icon }) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, mode: m }))}
                  disabled={!editing.tracked && m !== "set"}
                  className={`flex items-center justify-center gap-1.5 rounded-lg border py-2 font-medium transition disabled:opacity-40 ${
                    form.mode === m ? "border-primary bg-primary text-white" : "border-neutral-300 text-neutral-600 hover:bg-neutral-50"
                  }`}
                >
                  <Icon className="h-4 w-4" /> {label}
                </button>
              ))}
            </div>
            <label className="block">
              <span className="mb-1 block text-neutral-600">Quantity (kg)</span>
              <input
                type="number"
                min={0}
                step="any"
                autoFocus
                value={form.qty}
                onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))}
                className="h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 text-base text-neutral-900 outline-none focus:border-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-600">Reason</span>
              <select
                value={form.reason}
                onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                className="h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 text-neutral-900 outline-none focus:border-primary"
              >
                {ADJ_REASONS.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <div className="flex justify-between gap-2 pt-1">
              <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-neutral-300 px-4 py-2 font-medium text-neutral-700 hover:bg-neutral-50">
                Back
              </button>
              <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2 font-semibold text-white hover:opacity-90 disabled:opacity-50">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
