import { useState, useEffect, useMemo, useCallback } from "react"
import { Receipt, Loader2, Download, Store } from "lucide-react"
import { adminAPI } from "@food/api"
import { toast } from "sonner"

/**
 * POS Statement — seller-wise summary of Point-of-Sale (counter) orders.
 * POS orders live in the same order collection as app orders but carry
 * source:'pos'; the backend groups them per seller over an optional
 * date / zone / restaurant filter. Cancelled orders are excluded.
 */

const TIME_PRESETS = ["All Time", "Today", "Yesterday", "This Week", "This Month", "This Year", "Custom Range"]

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)

const computeDateRange = (time, fromStr, toStr) => {
  const now = new Date()
  let from = null
  let to = null
  switch (time) {
    case "Custom Range":
      if (fromStr) from = new Date(`${fromStr}T00:00:00`)
      if (toStr) to = new Date(`${toStr}T23:59:59.999`)
      break
    case "Today":
      from = startOfDay(now); to = endOfDay(now); break
    case "Yesterday": {
      const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      from = startOfDay(y); to = endOfDay(y); break
    }
    case "This Week": {
      const ws = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay())
      const we = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() + 6)
      from = startOfDay(ws); to = endOfDay(we); break
    }
    case "This Month":
      from = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1))
      to = endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0)); break
    case "This Year":
      from = startOfDay(new Date(now.getFullYear(), 0, 1))
      to = endOfDay(new Date(now.getFullYear(), 11, 31)); break
    default:
      break
  }
  return { from, to }
}

const inr = (n) =>
  `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const csvEscape = (v) => {
  const s = v == null ? "" : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export default function PosStatement() {
  const [sellers, setSellers] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [zones, setZones] = useState([])
  const [restaurants, setRestaurants] = useState([])
  const [filters, setFilters] = useState({
    zone: "All Zones",
    restaurant: "All restaurants",
    time: "All Time",
    fromDate: "",
    toDate: "",
  })

  useEffect(() => {
    (async () => {
      try {
        const [zres, rres] = await Promise.all([
          adminAPI.getZones({ limit: 1000 }),
          adminAPI.getRestaurants({ limit: 1000 }),
        ])
        setZones(zres?.data?.data?.zones || [])
        setRestaurants(rres?.data?.data?.restaurants || [])
      } catch {
        /* filters are optional — ignore load failure */
      }
    })()
  }, [])

  const loadStatement = useCallback(async () => {
    setLoading(true)
    try {
      const { from, to } = computeDateRange(filters.time, filters.fromDate, filters.toDate)
      const params = {
        zone: filters.zone !== "All Zones" ? filters.zone : undefined,
        restaurant: filters.restaurant !== "All restaurants" ? filters.restaurant : undefined,
        fromDate: from ? from.toISOString() : undefined,
        toDate: to ? to.toISOString() : undefined,
      }
      const res = await adminAPI.getPosStatementReport(params)
      setSellers(res?.data?.data?.sellers || [])
      setSummary(res?.data?.data?.summary || null)
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to load POS statement")
      setSellers([])
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => {
    loadStatement()
  }, [loadStatement])

  const tiles = useMemo(() => {
    const s = summary || {}
    return [
      { label: "Sellers", value: s.sellers || 0, money: false },
      { label: "POS Orders", value: s.orders || 0, money: false },
      { label: "Gross Sales", value: s.total || 0, money: true },
      { label: "Collected", value: s.collected || 0, money: true },
      { label: "Due", value: s.due || 0, money: true, warn: (s.due || 0) > 0 },
    ]
  }, [summary])

  const handleDownload = () => {
    if (!sellers.length) {
      toast.info("Nothing to download")
      return
    }
    const headers = ["Seller", "Owner", "Orders", "Subtotal", "Tax", "Discount", "Gross Total", "Cash", "UPI", "Card", "Other", "Collected", "Due"]
    const rows = sellers.map((s) => [
      s.sellerName, s.ownerName, s.orders,
      s.subtotal, s.tax, s.discount, s.total,
      s.cash, s.upi, s.card, s.other, s.collected, s.due,
    ])
    const csv = [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n")
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "pos-statement.csv"
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    toast.success(`Downloaded ${sellers.length} seller${sellers.length === 1 ? "" : "s"}`)
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen space-y-6">
      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center">
              <Receipt className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">POS Statement</h1>
              <p className="text-sm text-slate-500">
                Seller-wise summary of counter (Point-of-Sale) orders. Cancelled orders are excluded.
              </p>
            </div>
          </div>
          <button
            onClick={handleDownload}
            className="px-4 py-2.5 text-sm font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 flex items-center gap-2"
          >
            <Download className="w-4 h-4" /> Download CSV
          </button>
        </div>

        {/* Filters */}
        <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1">Zone</label>
            <select
              value={filters.zone}
              onChange={(e) => setFilters((p) => ({ ...p, zone: e.target.value }))}
              className="w-full px-3 py-2.5 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option>All Zones</option>
              {zones.map((z) => (
                <option key={z._id} value={z.name}>{z.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1">Seller</label>
            <select
              value={filters.restaurant}
              onChange={(e) => setFilters((p) => ({ ...p, restaurant: e.target.value }))}
              className="w-full px-3 py-2.5 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option>All restaurants</option>
              {restaurants.map((r) => (
                <option key={r._id} value={r.restaurantName}>{r.restaurantName}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1">Period</label>
            <select
              value={filters.time}
              onChange={(e) => setFilters((p) => ({ ...p, time: e.target.value }))}
              className="w-full px-3 py-2.5 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {TIME_PRESETS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          {filters.time === "Custom Range" && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1">From</label>
                <input
                  type="date"
                  value={filters.fromDate}
                  onChange={(e) => setFilters((p) => ({ ...p, fromDate: e.target.value }))}
                  className="w-full px-2 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1">To</label>
                <input
                  type="date"
                  value={filters.toDate}
                  onChange={(e) => setFilters((p) => ({ ...p, toDate: e.target.value }))}
                  className="w-full px-2 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {tiles.map((t) => (
          <div key={t.label} className="bg-white rounded-xl border border-slate-200 p-4">
            <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">{t.label}</p>
            <p className={`mt-1 text-xl font-bold ${t.warn ? "text-red-600" : "text-slate-900"}`}>
              {t.money ? inr(t.value) : t.value}
            </p>
          </div>
        ))}
      </div>

      {/* Seller table */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Seller</th>
                <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-700 uppercase tracking-wider">Orders</th>
                <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-700 uppercase tracking-wider">Subtotal</th>
                <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-700 uppercase tracking-wider">Tax</th>
                <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-700 uppercase tracking-wider">Discount</th>
                <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-700 uppercase tracking-wider">Cash</th>
                <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-700 uppercase tracking-wider">UPI</th>
                <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-700 uppercase tracking-wider">Card</th>
                <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-700 uppercase tracking-wider">Collected</th>
                <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-700 uppercase tracking-wider">Due</th>
                <th className="px-4 py-3 text-right text-[10px] font-bold text-slate-700 uppercase tracking-wider">Gross Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={11} className="px-4 py-16 text-center text-slate-500">
                    <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                    Loading POS statement…
                  </td>
                </tr>
              ) : sellers.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-16 text-center">
                    <Store className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                    <p className="text-sm font-semibold text-slate-700">No POS orders in this period</p>
                    <p className="text-xs text-slate-500 mt-1">Adjust the filters, or ring up a counter sale to see it here.</p>
                  </td>
                </tr>
              ) : (
                sellers.map((s) => (
                  <tr key={s.sellerId} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="text-sm font-semibold text-slate-900">{s.sellerName}</div>
                      {s.ownerName && <div className="text-xs text-slate-500">{s.ownerName}</div>}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-slate-700">{s.orders}</td>
                    <td className="px-4 py-3 text-right text-sm text-slate-700">{inr(s.subtotal)}</td>
                    <td className="px-4 py-3 text-right text-sm text-slate-700">{inr(s.tax)}</td>
                    <td className="px-4 py-3 text-right text-sm text-slate-700">{inr(s.discount)}</td>
                    <td className="px-4 py-3 text-right text-sm text-slate-700">{inr(s.cash)}</td>
                    <td className="px-4 py-3 text-right text-sm text-slate-700">{inr(s.upi)}</td>
                    <td className="px-4 py-3 text-right text-sm text-slate-700">{inr(s.card)}</td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-emerald-700">{inr(s.collected)}</td>
                    <td className={`px-4 py-3 text-right text-sm ${s.due > 0 ? "text-red-600 font-medium" : "text-slate-400"}`}>{inr(s.due)}</td>
                    <td className="px-4 py-3 text-right text-sm font-bold text-slate-900">{inr(s.total)}</td>
                  </tr>
                ))
              )}
            </tbody>
            {!loading && sellers.length > 0 && summary && (
              <tfoot className="bg-slate-50 border-t-2 border-slate-200">
                <tr className="font-bold text-slate-900">
                  <td className="px-4 py-3 text-sm">Total ({summary.sellers})</td>
                  <td className="px-4 py-3 text-right text-sm">{summary.orders}</td>
                  <td className="px-4 py-3 text-right text-sm">{inr(summary.subtotal)}</td>
                  <td className="px-4 py-3 text-right text-sm">{inr(summary.tax)}</td>
                  <td className="px-4 py-3 text-right text-sm">{inr(summary.discount)}</td>
                  <td className="px-4 py-3 text-right text-sm">{inr(summary.cash)}</td>
                  <td className="px-4 py-3 text-right text-sm">{inr(summary.upi)}</td>
                  <td className="px-4 py-3 text-right text-sm">{inr(summary.card)}</td>
                  <td className="px-4 py-3 text-right text-sm text-emerald-700">{inr(summary.collected)}</td>
                  <td className="px-4 py-3 text-right text-sm text-red-600">{inr(summary.due)}</td>
                  <td className="px-4 py-3 text-right text-sm">{inr(summary.total)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  )
}
