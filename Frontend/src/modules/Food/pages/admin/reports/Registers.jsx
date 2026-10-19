import { useEffect, useMemo, useState } from "react"
import { Loader2, RefreshCw, AlertTriangle } from "lucide-react"
import { adminAPI } from "@food/api"

/**
 * The cash-drawer report: every register session across stores, with its
 * opening float and closing count side by side and the difference between what
 * the till expected and what the cashier counted. Filter by store, status and
 * date; a short or over drawer is flagged with the reason and who approved it.
 */

const inr = (n) => n == null ? "—" : `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dt = (d) => d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"

export default function Registers() {
  const [stores, setStores] = useState([])
  const [rows, setRows] = useState([])
  const [totals, setTotals] = useState(null)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ restaurantId: "", status: "", from: "", to: "" })
  const [expanded, setExpanded] = useState(null)

  useEffect(() => {
    adminAPI.getApprovedRestaurants({ limit: 1000, page: 1 })
      .then((res) => {
        const d = res?.data?.data
        setStores(Array.isArray(d?.restaurants) ? d.restaurants : Array.isArray(d) ? d : [])
      })
      .catch(() => setStores([]))
  }, [])

  const load = useMemo(() => async () => {
    setLoading(true)
    try {
      const params = { limit: 200 }
      if (filters.restaurantId) params.restaurantId = filters.restaurantId
      if (filters.status) params.status = filters.status
      if (filters.from) params.from = filters.from
      if (filters.to) params.to = filters.to
      const res = await adminAPI.getPosShifts(params)
      const d = res?.data?.data || {}
      setRows(d.shifts || [])
      setTotals(d.totals || null)
    } catch {
      setRows([]); setTotals(null)
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => { load() }, [load])

  const field = "h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-800 outline-none focus:border-sky-400"

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Registers</h1>
          <p className="mt-1 text-sm text-gray-500">Opening and closing cash for every till session, across stores.</p>
        </div>
        <button type="button" onClick={load} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-600">Store</span>
          <select className={field} value={filters.restaurantId} onChange={(e) => setFilters((f) => ({ ...f, restaurantId: e.target.value }))}>
            <option value="">All stores</option>
            {stores.map((s) => <option key={s._id} value={s._id}>{s.restaurantName || s.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-600">Status</span>
          <select className={field} value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-600">From</span>
          <input type="date" className={field} value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-600">To</span>
          <input type="date" className={field} value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
        </label>
      </div>

      {/* Totals */}
      {totals && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Total opening" value={inr(totals.openingCash)} />
          <Stat label="Total expected" value={inr(totals.expectedCash)} />
          <Stat label="Total counted" value={inr(totals.countedCash)} />
          <Stat label="Total difference" value={inr(totals.difference)} tone={totals.difference < 0 ? "bad" : totals.difference > 0 ? "warn" : "good"} />
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full min-w-[920px] text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2.5 font-medium">Store</th>
              <th className="px-3 py-2.5 font-medium">Shift</th>
              <th className="px-3 py-2.5 font-medium">Cashier</th>
              <th className="px-3 py-2.5 font-medium">Opened</th>
              <th className="px-3 py-2.5 font-medium">Closed</th>
              <th className="px-3 py-2.5 text-right font-medium">Opening</th>
              <th className="px-3 py-2.5 text-right font-medium">Cash sales</th>
              <th className="px-3 py-2.5 text-right font-medium">Expected</th>
              <th className="px-3 py-2.5 text-right font-medium">Closing</th>
              <th className="px-3 py-2.5 text-right font-medium">Difference</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={11} className="py-16 text-center text-gray-400"><Loader2 className="mx-auto h-6 w-6 animate-spin" /></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={11} className="py-16 text-center text-sm text-gray-400">No register sessions found</td></tr>
            ) : rows.map((s) => (
              <>
                <tr key={s.id} className="border-t border-gray-100 hover:bg-sky-50/40 cursor-pointer" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                  <td className="px-3 py-2.5 font-medium text-gray-900">{s.restaurantName || "—"}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-gray-600">{s.shiftCode}</td>
                  <td className="px-3 py-2.5 text-gray-700">{s.cashierName || "—"}</td>
                  <td className="px-3 py-2.5 text-gray-600">{dt(s.openedAt)}</td>
                  <td className="px-3 py-2.5 text-gray-600">{dt(s.closedAt)}</td>
                  <td className="px-3 py-2.5 text-right text-gray-800">{inr(s.openingCash)}</td>
                  <td className="px-3 py-2.5 text-right text-gray-800">{inr(s.cashSales)}</td>
                  <td className="px-3 py-2.5 text-right text-gray-800">{inr(s.expectedCash)}</td>
                  <td className="px-3 py-2.5 text-right font-medium text-gray-900">{inr(s.countedCash)}</td>
                  <td className={`px-3 py-2.5 text-right font-semibold ${s.difference < 0 ? "text-rose-600" : s.difference > 0 ? "text-amber-600" : "text-emerald-600"}`}>
                    {s.difference == null ? "—" : `${s.difference < 0 ? "−" : s.difference > 0 ? "+" : ""}${inr(Math.abs(s.difference))}`}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.status === "open" ? "bg-sky-50 text-sky-700" : "bg-gray-100 text-gray-600"}`}>{s.status}</span>
                  </td>
                </tr>
                {expanded === s.id && (
                  <tr key={`${s.id}-d`} className="border-t border-gray-100 bg-gray-50/60">
                    <td colSpan={11} className="px-4 py-3 text-xs text-gray-600">
                      <div className="flex flex-wrap gap-x-8 gap-y-1.5">
                        <span>Cash in: <b className="text-gray-800">{inr(s.cashReceived)}</b></span>
                        <span>Cash out: <b className="text-gray-800">{inr(s.cashOut)}</b></span>
                        <span>Refunds: <b className="text-gray-800">{inr(s.refunds)}</b></span>
                        <span>Bills: <b className="text-gray-800">{s.billsCount}</b></span>
                        {s.difference ? (
                          <span className="inline-flex items-center gap-1 text-rose-600"><AlertTriangle className="h-3.5 w-3.5" /> Reason: <b>{s.closeReason || "—"}</b> · Approved by: <b>{s.closeApprovedBy || "—"}</b></span>
                        ) : null}
                      </div>
                      {s.denominations && Object.keys(s.denominations).length ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {Object.entries(s.denominations).map(([note, count]) => (
                            <span key={note} className="rounded bg-white px-2 py-0.5 ring-1 ring-gray-200">₹{note} × {count}</span>
                          ))}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Stat({ label, value, tone }) {
  const color = tone === "bad" ? "text-rose-600" : tone === "warn" ? "text-amber-600" : tone === "good" ? "text-emerald-600" : "text-gray-900"
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold ${color}`}>{value}</div>
    </div>
  )
}
