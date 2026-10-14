import { useState, useEffect, useCallback, useMemo } from "react"
import { Loader2, Download, Inbox } from "lucide-react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"

/**
 * Generic admin report: a period filter, summary tiles, a sortable-less table
 * and a CSV export. Each concrete report passes its columns, tiles and a
 * fetch function; this keeps the five Reports & Operations pages consistent.
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
    case "Today": from = startOfDay(now); to = endOfDay(now); break
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
    default: break
  }
  return { from, to }
}

export const inr = (n) =>
  `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const dateLabel = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—")

const csvEscape = (v) => {
  const s = v == null ? "" : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * @param {object}   p
 * @param {string}   p.title
 * @param {string}   p.description
 * @param {Function} p.icon        lucide icon component
 * @param {Function} p.fetchReport (params) => Promise<{ rows, summary }>
 * @param {Array}    p.columns     [{ key, label, align?, money?, render? }]
 * @param {Array}    p.tiles       [{ label, key, money?, warn? }]
 * @param {Function} [p.rowKey]    (row, i) => key
 * @param {Function} [p.footer]    (summary) => cell values aligned to columns
 * @param {string}   p.csvName
 */
export default function DataReport({ title, description, icon: Icon, fetchReport, columns, tiles, rowKey, footer, csvName, showZone = false, showSeller = false }) {
  const [rows, setRows] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ time: "All Time", fromDate: "", toDate: "", zone: "All Zones", restaurant: "All restaurants" })
  const [zones, setZones] = useState([])
  const [restaurants, setRestaurants] = useState([])

  useEffect(() => {
    if (!showZone && !showSeller) return
    (async () => {
      try {
        const calls = []
        if (showZone) calls.push(adminAPI.getZones({ limit: 1000 })); else calls.push(Promise.resolve(null))
        if (showSeller) calls.push(adminAPI.getRestaurants({ limit: 1000 })); else calls.push(Promise.resolve(null))
        const [zres, rres] = await Promise.all(calls)
        if (zres) setZones(zres?.data?.data?.zones || [])
        if (rres) setRestaurants(rres?.data?.data?.restaurants || [])
      } catch {
        /* filters are optional */
      }
    })()
  }, [showZone, showSeller])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { from, to } = computeDateRange(filters.time, filters.fromDate, filters.toDate)
      const params = {
        fromDate: from ? from.toISOString() : undefined,
        toDate: to ? to.toISOString() : undefined,
        zone: showZone && filters.zone !== "All Zones" ? filters.zone : undefined,
        restaurant: showSeller && filters.restaurant !== "All restaurants" ? filters.restaurant : undefined,
      }
      const { rows: r, summary: s } = await fetchReport(params)
      setRows(r || [])
      setSummary(s || null)
    } catch (err) {
      toast.error(err?.response?.data?.message || `Failed to load ${title}`)
      setRows([])
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [filters, fetchReport, title])

  useEffect(() => { load() }, [load])

  const cell = (col, row) => {
    if (col.render) return col.render(row)
    const v = row[col.key]
    return col.money ? inr(v) : (v ?? "—")
  }

  const tileValues = useMemo(() => {
    const s = summary || {}
    return (tiles || []).map((t) => ({ ...t, value: t.money ? inr(s[t.key]) : (s[t.key] ?? 0) }))
  }, [summary, tiles])

  const handleDownload = () => {
    if (!rows.length) { toast.info("Nothing to download"); return }
    const header = columns.map((c) => c.label)
    const body = rows.map((row) => columns.map((c) => {
      if (c.money) return Number(row[c.key] || 0).toFixed(2)
      const v = row[c.key]
      return v == null ? "" : String(v)
    }))
    const csv = [header, ...body].map((r) => r.map(csvEscape).join(",")).join("\n")
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${csvName || "report"}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    toast.success(`Downloaded ${rows.length} row${rows.length === 1 ? "" : "s"}`)
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen space-y-6">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center">
              {Icon ? <Icon className="w-5 h-5 text-white" /> : null}
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
              <p className="text-sm text-slate-500">{description}</p>
            </div>
          </div>
          <button
            onClick={handleDownload}
            className="px-4 py-2.5 text-sm font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 flex items-center gap-2"
          >
            <Download className="w-4 h-4" /> Download CSV
          </button>
        </div>

        <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1">Period</label>
            <select
              value={filters.time}
              onChange={(e) => setFilters((p) => ({ ...p, time: e.target.value }))}
              className="w-full px-3 py-2.5 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {TIME_PRESETS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          {showZone && (
            <div>
              <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1">Zone</label>
              <select
                value={filters.zone}
                onChange={(e) => setFilters((p) => ({ ...p, zone: e.target.value }))}
                className="w-full px-3 py-2.5 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option>All Zones</option>
                {zones.map((z) => <option key={z._id} value={z.name}>{z.name}</option>)}
              </select>
            </div>
          )}
          {showSeller && (
            <div>
              <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1">Seller</label>
              <select
                value={filters.restaurant}
                onChange={(e) => setFilters((p) => ({ ...p, restaurant: e.target.value }))}
                className="w-full px-3 py-2.5 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option>All restaurants</option>
                {restaurants.map((r) => <option key={r._id} value={r.restaurantName}>{r.restaurantName}</option>)}
              </select>
            </div>
          )}
          {filters.time === "Custom Range" && (
            <div className="grid grid-cols-2 gap-2 lg:col-span-2">
              <div>
                <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1">From</label>
                <input type="date" value={filters.fromDate} onChange={(e) => setFilters((p) => ({ ...p, fromDate: e.target.value }))}
                  className="w-full px-2 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1">To</label>
                <input type="date" value={filters.toDate} onChange={(e) => setFilters((p) => ({ ...p, toDate: e.target.value }))}
                  className="w-full px-2 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
          )}
        </div>
      </div>

      {tiles?.length ? (
        <div className={`grid grid-cols-2 sm:grid-cols-3 gap-3 ${
          { 1: "lg:grid-cols-1", 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4" }[tiles.length] || "lg:grid-cols-5"
        }`}>
          {tileValues.map((t) => (
            <div key={t.label} className="bg-white rounded-xl border border-slate-200 p-4">
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">{t.label}</p>
              <p className={`mt-1 text-xl font-bold ${t.warn && Number((summary || {})[t.key]) > 0 ? "text-red-600" : "text-slate-900"}`}>{t.value}</p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className={`px-4 py-3 text-[10px] font-bold text-slate-700 uppercase tracking-wider ${c.align === "right" ? "text-right" : "text-left"}`}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={columns.length} className="px-4 py-16 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading…
                </td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={columns.length} className="px-4 py-16 text-center">
                  <Inbox className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                  <p className="text-sm font-semibold text-slate-700">No data in this period</p>
                  <p className="text-xs text-slate-500 mt-1">Adjust the period filter, or check back once there is activity.</p>
                </td></tr>
              ) : (
                rows.map((row, i) => (
                  <tr key={rowKey ? rowKey(row, i) : i} className="hover:bg-slate-50">
                    {columns.map((c) => (
                      <td key={c.key} className={`px-4 py-3 text-sm ${c.align === "right" ? "text-right" : "text-left"} ${c.className || "text-slate-700"}`}>
                        {cell(c, row)}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
            {!loading && rows.length > 0 && footer && summary ? (
              <tfoot className="bg-slate-50 border-t-2 border-slate-200">
                <tr className="font-bold text-slate-900">
                  {footer(summary).map((v, i) => (
                    <td key={i} className={`px-4 py-3 text-sm ${columns[i]?.align === "right" ? "text-right" : "text-left"}`}>{v}</td>
                  ))}
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </div>
    </div>
  )
}
