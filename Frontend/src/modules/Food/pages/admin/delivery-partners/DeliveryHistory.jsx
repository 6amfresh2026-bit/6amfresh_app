import { Fragment, useCallback, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { ChevronDown, ChevronRight, Loader2, Search } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"

/**
 * Delivery History — who carried which goods to whom, and when.
 *
 * The panel could already say how much a rider had earned and where they were
 * standing, but not what they actually handed over. That is the record a
 * missing-item complaint or a cash dispute turns into, so each row opens into
 * the item lines and the timestamps behind them rather than linking away to
 * the order screen.
 *
 * Ordered by when the goods were delivered, not when the order was placed: a
 * late-night order handed over after midnight belongs to the day it arrived.
 */

const PAGE_SIZES = [20, 50, 100]

const money = (n) => `₹${(Number(n) || 0).toFixed(2)}`

const dateTime = (value) => {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

const mins = (value) => (value === null || value === undefined ? "—" : `${value} min`)

const OUTCOME = {
  delivered: { label: "Delivered", className: "bg-emerald-100 text-emerald-800" },
  cancelled: { label: "Cancelled", className: "bg-rose-100 text-rose-800" },
  // Cancelled after the rider already had the goods, so the stock physically
  // came back. Worth its own badge: it costs a trip and a restock, which a
  // plain cancellation does not.
  returned: { label: "Returned to store", className: "bg-amber-100 text-amber-800" },
}

const MODE_LABEL = {
  auto: "Auto-assigned",
  fleet: "Seller's own rider",
  manual: "Manually assigned",
}

export default function DeliveryHistory() {
  const [searchParams, setSearchParams] = useSearchParams()

  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [expanded, setExpanded] = useState(() => new Set())

  const [riders, setRiders] = useState([])
  // Seeded from the URL so "history for this rider" is a link the Deliveryman
  // List can hand over, and so a filtered view survives a refresh.
  const [riderId, setRiderId] = useState(() => searchParams.get("riderId") || "")
  const [from, setFrom] = useState(() => searchParams.get("from") || "")
  const [to, setTo] = useState(() => searchParams.get("to") || "")
  const [outcome, setOutcome] = useState(() => searchParams.get("outcome") || "all")
  const [search, setSearch] = useState(() => searchParams.get("search") || "")
  const [debouncedSearch, setDebouncedSearch] = useState(search)

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPage(1)
    }, 300)
    return () => window.clearTimeout(id)
  }, [search])

  useEffect(() => {
    ;(async () => {
      try {
        const res = await adminAPI.getDeliveryPartners({ page: 1, limit: 1000 })
        const list =
          res?.data?.data?.deliveryPartners ||
          res?.data?.data?.partners ||
          res?.data?.data ||
          []
        setRiders(Array.isArray(list) ? list : [])
      } catch {
        // The filter degrades to "all riders"; the history itself still loads.
      }
    })()
  }, [])

  const fetchRows = useCallback(async () => {
    setLoading(true)
    try {
      const params = { page, limit: pageSize }
      if (riderId) params.deliveryPartnerId = riderId
      if (outcome && outcome !== "all") params.outcome = outcome
      if (from) params.from = from
      if (to) params.to = to
      if (debouncedSearch) params.search = debouncedSearch

      const res = await adminAPI.getDeliveryHistory(params)
      const data = res?.data?.data || {}
      setRows(Array.isArray(data.deliveries) ? data.deliveries : [])
      setTotal(Number(data?.pagination?.total) || 0)
      setExpanded(new Set())
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not load delivery history")
      setRows([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, riderId, outcome, from, to, debouncedSearch])

  useEffect(() => {
    fetchRows()
  }, [fetchRows])

  // Keeps the address bar in step with the filters, so a filtered view can be
  // sent to someone else as a link.
  useEffect(() => {
    const next = {}
    if (riderId) next.riderId = riderId
    if (outcome && outcome !== "all") next.outcome = outcome
    if (from) next.from = from
    if (to) next.to = to
    if (debouncedSearch) next.search = debouncedSearch
    setSearchParams(next, { replace: true })
  }, [riderId, outcome, from, to, debouncedSearch, setSearchParams])

  const toggleRow = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const summary = useMemo(() => {
    const cash = rows.reduce((sum, r) => sum + (r.payment?.cashCollected || 0), 0)
    const items = rows.reduce((sum, r) => sum + (r.itemCount || 0), 0)
    const short = rows.reduce((sum, r) => sum + (r.shortPickedLines || 0), 0)
    return { cash, items, short }
  }, [rows])

  const riderName = (r) => r?.name || r?.fullName || "Unnamed rider"
  const riderKey = (r) => String(r?._id || r?.id || "")

  const clearFilters = () => {
    setRiderId("")
    setOutcome("all")
    setFrom("")
    setTo("")
    setSearch("")
    setPage(1)
  }

  const anyFilter = riderId || (outcome && outcome !== "all") || from || to || search

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-neutral-900">Delivery History</h1>
        <p className="text-sm text-neutral-500">
          Every completed delivery — which rider, which customer, which items, and when.
        </p>
      </div>

      <div className="mb-4 rounded-lg border border-neutral-200 bg-white p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <div>
            <label className="mb-1 block text-sm font-semibold text-neutral-800">Delivery Boy</label>
            <select
              value={riderId}
              onChange={(e) => {
                setRiderId(e.target.value)
                setPage(1)
              }}
              className="h-10 w-full rounded border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-blue-500"
            >
              <option value="">All delivery boys</option>
              {riders.map((r) => (
                <option key={riderKey(r)} value={riderKey(r)}>
                  {riderName(r)} {r?.phone ? `· ${r.phone}` : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-semibold text-neutral-800">Outcome</label>
            <select
              value={outcome}
              onChange={(e) => {
                setOutcome(e.target.value)
                setPage(1)
              }}
              className="h-10 w-full rounded border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-blue-500"
            >
              <option value="all">All outcomes</option>
              <option value="delivered">Delivered</option>
              <option value="cancelled">Cancelled</option>
              <option value="returned">Returned to store</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-semibold text-neutral-800">Delivered From</label>
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value)
                setPage(1)
              }}
              className="h-10 w-full rounded border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-semibold text-neutral-800">Delivered To</label>
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value)
                setPage(1)
              }}
              className="h-10 w-full rounded border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-semibold text-neutral-800">Search</label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
              {/* Product name is searchable too: "who received the milk from
                  that batch" is the same question from the other end. */}
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Order ID, customer, phone or product"
                className="h-10 w-full rounded border border-neutral-300 bg-white pl-9 pr-3 text-sm outline-none focus:border-blue-500"
              />
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-neutral-600">
          <span>
            <strong className="text-neutral-900">{total}</strong> deliveries
          </span>
          <span className="text-neutral-300">|</span>
          <span>
            {summary.items} items on this page · {money(summary.cash)} cash collected
          </span>
          {summary.short > 0 && (
            <>
              <span className="text-neutral-300">|</span>
              <span className="text-amber-700">{summary.short} short-picked line(s)</span>
            </>
          )}
          {anyFilter && (
            <button type="button" onClick={clearFilters} className="ml-auto text-blue-600 underline">
              Clear filters
            </button>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="w-8 px-3 py-3" />
                <th className="px-3 py-3">Order</th>
                <th className="px-3 py-3">Delivery Boy</th>
                <th className="px-3 py-3">Customer</th>
                <th className="px-3 py-3">Items</th>
                <th className="px-3 py-3">Outcome</th>
                <th className="px-3 py-3">Ended At</th>
                <th className="px-3 py-3">Took</th>
                <th className="px-3 py-3 text-right">Order Total</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-neutral-400">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                  </td>
                </tr>
              )}

              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-neutral-500">
                    No deliveries match these filters.
                  </td>
                </tr>
              )}

              {!loading &&
                rows.map((row) => {
                  const open = expanded.has(row.orderObjectId)
                  return (
                    <Fragment key={row.orderObjectId}>
                      <tr
                        onClick={() => toggleRow(row.orderObjectId)}
                        className="cursor-pointer border-t border-neutral-100 hover:bg-neutral-50"
                      >
                        <td className="px-3 py-3 text-neutral-400">
                          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-medium text-neutral-900">{row.orderId}</div>
                          <div className="text-xs text-neutral-500">{row.seller || "—"}</div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-medium text-neutral-900">{row.rider?.name || "—"}</div>
                          <div className="text-xs text-neutral-500">{row.rider?.phone || ""}</div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-medium text-neutral-900">{row.customer?.name || "—"}</div>
                          <div className="text-xs text-neutral-500">{row.customer?.phone || ""}</div>
                        </td>
                        <td className="px-3 py-3">
                          {row.itemCount}
                          {row.shortPickedLines > 0 && (
                            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                              {row.shortPickedLines} short
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <span
                            className={`rounded px-2 py-0.5 text-xs font-medium ${
                              (OUTCOME[row.outcome] || OUTCOME.delivered).className
                            }`}
                          >
                            {(OUTCOME[row.outcome] || OUTCOME.delivered).label}
                          </span>
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">{dateTime(row.timeline?.endedAt)}</td>
                        <td className="px-3 py-3 whitespace-nowrap">{mins(row.timeline?.minutesTotal)}</td>
                        <td className="px-3 py-3 text-right font-medium">{money(row.payment?.orderTotal)}</td>
                      </tr>

                      {open && (
                        <tr className="border-t border-neutral-100 bg-neutral-50/60">
                          <td />
                          <td colSpan={8} className="px-3 py-4">
                            <div className="grid gap-5 lg:grid-cols-3">
                              <div className="lg:col-span-2">
                                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                                  {row.outcome === "delivered" ? "What was handed over" : "What was on the order"}
                                </h4>
                                <table className="w-full text-sm">
                                  <thead className="text-left text-xs text-neutral-500">
                                    <tr>
                                      <th className="py-1">Product</th>
                                      <th className="py-1 text-right">Ordered</th>
                                      <th className="py-1 text-right">Delivered</th>
                                      <th className="py-1 text-right">Unit</th>
                                      <th className="py-1 text-right">Total</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {row.items.map((line, i) => (
                                      <tr key={i} className="border-t border-neutral-200">
                                        <td className="py-1.5">
                                          {line.name}
                                          {line.variantName ? (
                                            <span className="text-neutral-500"> · {line.variantName}</span>
                                          ) : null}
                                        </td>
                                        <td className="py-1.5 text-right">{line.orderedQuantity}</td>
                                        <td
                                          className={`py-1.5 text-right ${
                                            line.shortPicked ? "font-semibold text-amber-700" : ""
                                          }`}
                                        >
                                          {line.deliveredQuantity}
                                        </td>
                                        <td className="py-1.5 text-right">{money(line.unitPrice)}</td>
                                        <td className="py-1.5 text-right">{money(line.lineTotal)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>

                              <div className="space-y-4 text-sm">
                                <div>
                                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                                    {row.outcome === "delivered" ? "Delivered to" : "Was for"}
                                  </h4>
                                  <div className="text-neutral-800">{row.customer?.name || "—"}</div>
                                  <div className="text-neutral-600">{row.customer?.phone || ""}</div>
                                  <div className="text-neutral-600">{row.customer?.address || "—"}</div>
                                </div>

                                <div>
                                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                                    Timeline
                                  </h4>
                                  <dl className="space-y-0.5 text-neutral-700">
                                    <div className="flex justify-between gap-4">
                                      <dt>Placed</dt>
                                      <dd>{dateTime(row.timeline?.placedAt)}</dd>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                      <dt>Assigned</dt>
                                      <dd>{dateTime(row.timeline?.assignedAt)}</dd>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                      <dt>Picked up</dt>
                                      <dd>{dateTime(row.timeline?.pickedUpAt)}</dd>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                      <dt>{row.outcome === "delivered" ? "Delivered" : "Cancelled"}</dt>
                                      <dd>{dateTime(row.timeline?.endedAt)}</dd>
                                    </div>
                                    {row.cancellation && (
                                      <div className="flex justify-between gap-4">
                                        <dt>Cancelled by</dt>
                                        <dd className="text-right">
                                          {row.cancellation.byRole || "—"}
                                          {row.cancellation.note ? (
                                            <span className="block text-xs text-neutral-500">
                                              {row.cancellation.note}
                                            </span>
                                          ) : null}
                                        </dd>
                                      </div>
                                    )}
                                    <div className="flex justify-between gap-4">
                                      <dt>On the road</dt>
                                      <dd>{mins(row.timeline?.minutesOnRoad)}</dd>
                                    </div>
                                  </dl>
                                </div>

                                <div>
                                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                                    Payment &amp; assignment
                                  </h4>
                                  <dl className="space-y-0.5 text-neutral-700">
                                    <div className="flex justify-between gap-4">
                                      <dt>Method</dt>
                                      <dd className="uppercase">{row.payment?.method || "—"}</dd>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                      <dt>Cash collected</dt>
                                      <dd>{money(row.payment?.cashCollected)}</dd>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                      <dt>Rider earning</dt>
                                      <dd>{money(row.riderEarning)}</dd>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                      <dt>How assigned</dt>
                                      <dd>
                                        {MODE_LABEL[row.assignment?.mode] || row.assignment?.mode || "—"}
                                        {row.assignment?.byRole ? ` (${row.assignment.byRole})` : ""}
                                      </dd>
                                    </div>
                                  </dl>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 px-3 py-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-neutral-600">Rows</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value))
                setPage(1)
              }}
              className="h-9 rounded border border-neutral-300 bg-white px-2 text-sm outline-none"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded border border-neutral-300 px-3 py-1.5 disabled:opacity-50"
            >
              Previous
            </button>
            <span className="text-neutral-600">
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded border border-neutral-300 px-3 py-1.5 disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
