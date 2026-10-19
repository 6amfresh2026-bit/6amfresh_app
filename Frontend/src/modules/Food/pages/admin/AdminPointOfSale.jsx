import { useEffect, useMemo, useState } from "react"
import { Search, Store, Loader2, ArrowRight } from "lucide-react"
import { adminAPI } from "@food/api"
import PointOfSale from "@food/pages/restaurant/pos/PointOfSale"
import { PosApiProvider, adminPosApi } from "@food/components/restaurant/pos/posApiContext"

/**
 * The admin's till. Admin has no shop of its own, so it first picks a store;
 * from there it runs the exact same POS the seller does — register, billing,
 * credit notes, loyalty, barcode scan — through the admin POS endpoints bound
 * to that store. "Exit POS" returns here to the picker rather than logging out.
 */
export default function AdminPointOfSale() {
  const [stores, setStores] = useState([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [storeId, setStoreId] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    adminAPI
      .getApprovedRestaurants({ limit: 1000, page: 1 })
      .then((res) => {
        if (cancelled) return
        const body = res?.data
        const data = body?.data
        const rows = Array.isArray(data?.restaurants) ? data.restaurants
          : Array.isArray(data) ? data
          : Array.isArray(body?.restaurants) ? body.restaurants : []
        setStores(rows)
      })
      .catch(() => { if (!cancelled) setStores([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // A fresh api bound to the chosen store; the POS remounts per store (keyed
  // below) so its cart, register and customer state never leak across shops.
  const api = useMemo(() => (storeId ? adminPosApi(storeId) : null), [storeId])

  if (storeId && api) {
    return (
      <PosApiProvider value={api}>
        <PointOfSale key={storeId} onExit={() => setStoreId(null)} />
      </PosApiProvider>
    )
  }

  const q = query.trim().toLowerCase()
  const filtered = !q ? stores : stores.filter((s) =>
    String(s.restaurantName || s.name || "").toLowerCase().includes(q) ||
    String(s.restaurantId || s._id || "").toLowerCase().includes(q)
  )

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Point of Sale</h1>
        <p className="mt-1 text-sm text-gray-500">Pick a store to run its till — billing, register, credit notes, loyalty and barcode scan.</p>
      </div>

      <div className="mb-4 flex items-center rounded-lg border border-gray-300 bg-white px-3 focus-within:border-sky-400">
        <Search className="h-4 w-4 text-gray-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search stores by name or ID"
          className="h-11 w-full bg-transparent px-2 text-[15px] text-gray-800 outline-none"
          autoFocus
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 py-16 text-center text-sm text-gray-400">No stores found</div>
      ) : (
        <ul className="space-y-2">
          {filtered.map((s) => (
            <li key={s._id}>
              <button
                type="button"
                onClick={() => setStoreId(s._id)}
                className="group flex w-full items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 text-left hover:border-sky-300 hover:bg-sky-50"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-600"><Store className="h-5 w-5" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium text-gray-900">{s.restaurantName || s.name || "Unnamed store"}</span>
                  <span className="block truncate text-xs text-gray-500">ID: {s.restaurantId || s._id}</span>
                </span>
                <ArrowRight className="h-4 w-4 text-gray-300 group-hover:text-sky-500" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
