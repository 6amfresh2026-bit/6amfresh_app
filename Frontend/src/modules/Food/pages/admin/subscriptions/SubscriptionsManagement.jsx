import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Search,
  Users,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@food/components/ui/dialog"
import AddSubscriptionDialog from "@food/components/admin/AddSubscriptionDialog"

/**
 * Admin view over customer product subscriptions.
 *
 * Two tabs, because they answer different questions:
 *  - Deliveries: what has to go out on a given day, and what happened to it.
 *    This is the morning view, so it is the one that opens first.
 *  - Subscriptions: the standing arrangements behind those deliveries.
 *
 * The one write is starting a subscription for a customer who phoned instead
 * of using the app. Editing an existing one stays with the customer: it is
 * their arrangement, and they can pause or cancel it themselves.
 */

const TABS = [
  { id: "deliveries", label: "Today's Deliveries" },
  { id: "subscriptions", label: "All Subscriptions" },
]

/** Local YYYY-MM-DD. toISOString() would shift the day for any timezone behind UTC. */
const toDateInput = (date) => {
  const d = new Date(date)
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const shiftDate = (value, days) => {
  const [y, m, d] = String(value).split("-").map(Number)
  const next = new Date(y, m - 1, d)
  next.setDate(next.getDate() + days)
  return toDateInput(next)
}

const DELIVERY_STATUS = {
  scheduled: { label: "Scheduled", className: "bg-blue-50 text-blue-700 ring-blue-200" },
  order_placed: { label: "Order placed", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  cancelled: { label: "Cancelled", className: "bg-neutral-100 text-neutral-600 ring-neutral-200" },
  failed: { label: "Failed", className: "bg-rose-50 text-rose-700 ring-rose-200" },
}

const SUBSCRIPTION_STATUS = {
  active: { label: "Active", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  paused: { label: "Paused", className: "bg-amber-50 text-amber-700 ring-amber-200" },
  cancelled: { label: "Cancelled", className: "bg-neutral-100 text-neutral-600 ring-neutral-200" },
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

const StatusPill = ({ map, value }) => {
  const entry = map[value] || { label: value || "—", className: "bg-neutral-100 text-neutral-600 ring-neutral-200" }
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${entry.className}`}>
      {entry.label}
    </span>
  )
}

/** "daily", "weekly (Mon, Thu)", "monthly (day 5)" */
/**
 * When a subscription is delivered, in the customer's words.
 *
 * They picked "Evening 6-8 PM", not "18:00" — show the window they know when
 * there is one, and fall back to the typed time for the older rows that have
 * no window.
 */
const describeDeliveryTime = (row) => {
  const slot = row?.deliverySlot
  if (slot?.label && slot?.startTime && slot?.endTime) {
    return `${slot.label} · ${slot.startTime}–${slot.endTime}`
  }
  return row?.deliveryTime || ''
}

const describeSchedule = (row) => {
  if (row.frequency === "weekly") {
    const days = (row.daysOfWeek || []).map((d) => WEEKDAYS[d]).filter(Boolean)
    return days.length ? `Weekly · ${days.join(", ")}` : "Weekly"
  }
  if (row.frequency === "monthly") {
    return row.dayOfMonth ? `Monthly · day ${row.dayOfMonth}` : "Monthly"
  }
  return "Daily"
}

const formatDate = (value) => {
  if (!value) return "—"
  return new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

const StatCard = ({ icon: Icon, label, value, tone }) => (
  <div className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white p-4">
    <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${tone}`}>
      <Icon className="h-5 w-5" />
    </div>
    <div className="min-w-0">
      <p className="text-2xl font-semibold leading-none text-neutral-900">{value}</p>
      <p className="mt-1 truncate text-xs text-neutral-500">{label}</p>
    </div>
  </div>
)

const EmptyRow = ({ colSpan, children }) => (
  <tr>
    <td colSpan={colSpan} className="px-4 py-14 text-center text-sm text-neutral-500">
      {children}
    </td>
  </tr>
)

const LoadingRow = ({ colSpan }) => (
  <tr>
    <td colSpan={colSpan} className="px-4 py-14 text-center">
      <Loader2 className="mx-auto h-6 w-6 animate-spin text-neutral-400" />
    </td>
  </tr>
)

export default function SubscriptionsManagement() {
  const [tab, setTab] = useState("deliveries")

  // ─── Deliveries tab ───
  const [date, setDate] = useState(() => toDateInput(new Date()))
  const [deliveryStatus, setDeliveryStatus] = useState("all")
  const [deliveries, setDeliveries] = useState([])
  const [summary, setSummary] = useState(null)
  const [deliveriesLoading, setDeliveriesLoading] = useState(true)

  // ─── Subscriptions tab ───
  const [subs, setSubs] = useState([])
  const [subsTotal, setSubsTotal] = useState(0)
  const [subsPage, setSubsPage] = useState(1)
  const [subsLoading, setSubsLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState("all")
  const [frequencyFilter, setFrequencyFilter] = useState("all")
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")

  // ─── Detail dialog ───
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // ─── New subscription ───
  const [addOpen, setAddOpen] = useState(false)

  const pageSize = 20
  const isToday = date === toDateInput(new Date())

  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedSearch(search.trim())
      setSubsPage(1)
    }, 300)
    return () => window.clearTimeout(id)
  }, [search])

  const fetchDeliveries = useCallback(async () => {
    setDeliveriesLoading(true)
    try {
      const params = { date, limit: 200 }
      if (deliveryStatus !== "all") params.status = deliveryStatus
      const [listRes, summaryRes] = await Promise.all([
        adminAPI.getSubscriptionDeliveries(params),
        adminAPI.getSubscriptionDeliverySummary({ date }),
      ])
      setDeliveries(listRes?.data?.data?.deliveries || [])
      setSummary(summaryRes?.data?.data || null)
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to load deliveries")
      setDeliveries([])
      setSummary(null)
    } finally {
      setDeliveriesLoading(false)
    }
  }, [date, deliveryStatus])

  const fetchSubscriptions = useCallback(async () => {
    setSubsLoading(true)
    try {
      const params = { page: subsPage, limit: pageSize }
      if (statusFilter !== "all") params.status = statusFilter
      if (frequencyFilter !== "all") params.frequency = frequencyFilter
      if (debouncedSearch) params.search = debouncedSearch
      const res = await adminAPI.getProductSubscriptions(params)
      setSubs(res?.data?.data?.subscriptions || [])
      setSubsTotal(Number(res?.data?.data?.total) || 0)
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to load subscriptions")
      setSubs([])
      setSubsTotal(0)
    } finally {
      setSubsLoading(false)
    }
  }, [subsPage, statusFilter, frequencyFilter, debouncedSearch])

  useEffect(() => {
    if (tab === "deliveries") fetchDeliveries()
  }, [tab, fetchDeliveries])

  useEffect(() => {
    if (tab === "subscriptions") fetchSubscriptions()
  }, [tab, fetchSubscriptions])

  const openDetail = async (subscriptionId) => {
    setDetailLoading(true)
    setDetail({ subscription: null, upcoming: [], recent: [] })
    try {
      const res = await adminAPI.getProductSubscription(subscriptionId)
      setDetail(res?.data?.data || null)
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to load subscription")
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(subsTotal / pageSize))

  const counts = summary?.counts || {}
  const statCards = useMemo(
    () => [
      { icon: Package, label: "Total deliveries", value: summary?.total ?? 0, tone: "bg-neutral-100 text-neutral-700" },
      { icon: Clock, label: "Scheduled", value: counts.scheduled ?? 0, tone: "bg-blue-50 text-blue-600" },
      { icon: CheckCircle2, label: "Order placed", value: counts.order_placed ?? 0, tone: "bg-emerald-50 text-emerald-600" },
      { icon: XCircle, label: "Failed", value: counts.failed ?? 0, tone: "bg-rose-50 text-rose-600" },
      { icon: Users, label: "Active subscriptions", value: summary?.activeSubscriptions ?? 0, tone: "bg-violet-50 text-violet-600" },
    ],
    [summary, counts.scheduled, counts.order_placed, counts.failed]
  )

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-pink-500 text-white">
            <RefreshCw className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-neutral-900">Subscriptions</h1>
            <p className="text-sm text-neutral-500">Recurring customer deliveries</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-pink-500 px-4 text-sm font-medium text-white hover:bg-pink-600"
        >
          <Plus className="h-4 w-4" />
          New subscription
        </button>
      </div>

      <div className="flex gap-1 border-b border-neutral-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition ${
              tab === t.id
                ? "border-pink-500 text-pink-600"
                : "border-transparent text-neutral-500 hover:text-neutral-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "deliveries" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setDate((d) => shiftDate(d, -1))}
              className="grid h-9 w-9 place-items-center rounded-lg border border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50"
              aria-label="Previous day"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="relative">
              <Calendar className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value || toDateInput(new Date()))}
                className="h-9 rounded-lg border border-neutral-200 bg-white pl-9 pr-3 text-sm text-neutral-800 outline-none focus:border-pink-400"
              />
            </div>
            <button
              type="button"
              onClick={() => setDate((d) => shiftDate(d, 1))}
              className="grid h-9 w-9 place-items-center rounded-lg border border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50"
              aria-label="Next day"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            {!isToday && (
              <button
                type="button"
                onClick={() => setDate(toDateInput(new Date()))}
                className="h-9 rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-700 hover:bg-neutral-50"
              >
                Today
              </button>
            )}

            <select
              value={deliveryStatus}
              onChange={(e) => setDeliveryStatus(e.target.value)}
              className="ml-auto h-9 rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-700 outline-none focus:border-pink-400"
            >
              <option value="all">All statuses</option>
              <option value="scheduled">Scheduled</option>
              <option value="order_placed">Order placed</option>
              <option value="cancelled">Cancelled</option>
              <option value="failed">Failed</option>
            </select>
            <button
              type="button"
              onClick={fetchDeliveries}
              className="grid h-9 w-9 place-items-center rounded-lg border border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50"
              aria-label="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${deliveriesLoading ? "animate-spin" : ""}`} />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {statCards.map((card) => (
              <StatCard key={card.label} {...card} />
            ))}
          </div>

          <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Time</th>
                    <th className="px-4 py-3 font-medium">Customer</th>
                    <th className="px-4 py-3 font-medium">Item</th>
                    <th className="px-4 py-3 font-medium">Qty</th>
                    <th className="px-4 py-3 font-medium">Restaurant</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Order</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {deliveriesLoading ? (
                    <LoadingRow colSpan={7} />
                  ) : deliveries.length === 0 ? (
                    <EmptyRow colSpan={7}>No deliveries scheduled for this day.</EmptyRow>
                  ) : (
                    deliveries.map((row) => (
                      <tr
                        key={row.id}
                        onClick={() => openDetail(row.subscriptionId)}
                        className="cursor-pointer hover:bg-neutral-50"
                      >
                        <td className="whitespace-nowrap px-4 py-3 font-medium text-neutral-900">{describeDeliveryTime(row)}</td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-neutral-900">{row.customer?.name}</div>
                          <div className="text-xs text-neutral-500">{row.customer?.phone}</div>
                        </td>
                        <td className="px-4 py-3 text-neutral-800">{row.itemName}</td>
                        <td className="px-4 py-3 text-neutral-600">{row.quantity ?? "—"}</td>
                        <td className="px-4 py-3 text-neutral-600">{row.restaurantName}</td>
                        <td className="px-4 py-3">
                          <StatusPill map={DELIVERY_STATUS} value={row.status} />
                          {row.status === "failed" && row.failureReason && (
                            <div className="mt-1 text-xs text-rose-600">{row.failureReason}</div>
                          )}
                          {row.status === "cancelled" && row.cancelReason && (
                            <div className="mt-1 text-xs text-neutral-500">{row.cancelReason}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-neutral-600">
                          {row.order ? (
                            <span className="font-medium text-neutral-900">#{row.order.orderId}</span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === "subscriptions" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search customer or item..."
                className="h-9 w-full rounded-lg border border-neutral-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-pink-400"
              />
            </div>
            <select
              value={frequencyFilter}
              onChange={(e) => { setFrequencyFilter(e.target.value); setSubsPage(1) }}
              className="h-9 rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-700 outline-none focus:border-pink-400"
            >
              <option value="all">All frequencies</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setSubsPage(1) }}
              className="h-9 rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-700 outline-none focus:border-pink-400"
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>

          <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Customer</th>
                    <th className="px-4 py-3 font-medium">Item</th>
                    <th className="px-4 py-3 font-medium">Qty</th>
                    <th className="px-4 py-3 font-medium">Schedule</th>
                    <th className="px-4 py-3 font-medium">Time</th>
                    <th className="px-4 py-3 font-medium">Started</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {subsLoading ? (
                    <LoadingRow colSpan={7} />
                  ) : subs.length === 0 ? (
                    <EmptyRow colSpan={7}>No subscriptions found.</EmptyRow>
                  ) : (
                    subs.map((row) => (
                      <tr key={row.id} onClick={() => openDetail(row.id)} className="cursor-pointer hover:bg-neutral-50">
                        <td className="px-4 py-3">
                          <div className="font-medium text-neutral-900">{row.customer?.name}</div>
                          <div className="text-xs text-neutral-500">{row.customer?.phone}</div>
                        </td>
                        <td className="px-4 py-3 text-neutral-800">{row.itemName}</td>
                        <td className="px-4 py-3 text-neutral-600">{row.quantity}</td>
                        <td className="px-4 py-3 text-neutral-600">{describeSchedule(row)}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-neutral-600">{describeDeliveryTime(row)}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-neutral-600">{formatDate(row.startDate)}</td>
                        <td className="px-4 py-3"><StatusPill map={SUBSCRIPTION_STATUS} value={row.status} /></td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between border-t border-neutral-100 px-4 py-3 text-sm text-neutral-600">
              <span>{subsTotal} subscription{subsTotal === 1 ? "" : "s"}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={subsPage <= 1}
                  onClick={() => setSubsPage((p) => Math.max(1, p - 1))}
                  className="rounded-lg border border-neutral-200 px-3 py-1.5 disabled:opacity-40"
                >
                  Prev
                </button>
                <span>{subsPage} / {totalPages}</span>
                <button
                  type="button"
                  disabled={subsPage >= totalPages}
                  onClick={() => setSubsPage((p) => Math.min(totalPages, p + 1))}
                  className="rounded-lg border border-neutral-200 px-3 py-1.5 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <AddSubscriptionDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={() => {
          // The new arrangement is on the Subscriptions tab, and its first
          // deliveries are already generated — so switch there and reload both.
          setTab("subscriptions")
          setSubsPage(1)
          fetchSubscriptions()
          fetchDeliveries()
        }}
      />

      <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto p-5 sm:max-w-2xl sm:p-6">
          <DialogHeader className="pr-8">
            <DialogTitle className="text-lg font-bold text-neutral-900">Subscription details</DialogTitle>
          </DialogHeader>

          {detailLoading || !detail?.subscription ? (
            <div className="py-12 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-neutral-400" />
            </div>
          ) : (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-4 rounded-xl bg-neutral-50 p-4 text-sm">
                <div>
                  <p className="text-xs text-neutral-500">Customer</p>
                  <p className="font-medium text-neutral-900">{detail.subscription.customer?.name}</p>
                  <p className="text-xs text-neutral-500">{detail.subscription.customer?.phone}</p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Item</p>
                  <p className="font-medium text-neutral-900">
                    {detail.subscription.itemName} × {detail.subscription.quantity}
                  </p>
                  <p className="text-xs text-neutral-500">{detail.subscription.restaurantName}</p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Schedule</p>
                  <p className="font-medium text-neutral-900">{describeSchedule(detail.subscription)}</p>
                  <p className="text-xs text-neutral-500">at {describeDeliveryTime(detail.subscription)}</p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Status</p>
                  <StatusPill map={SUBSCRIPTION_STATUS} value={detail.subscription.status} />
                  <p className="mt-1 text-xs text-neutral-500">
                    Payment: {detail.subscription.paymentMethod} · Since {formatDate(detail.subscription.startDate)}
                  </p>
                </div>
              </div>

              <div>
                <h3 className="mb-2 text-sm font-semibold text-neutral-900">Upcoming deliveries</h3>
                {detail.upcoming.length === 0 ? (
                  <p className="rounded-lg bg-neutral-50 px-3 py-4 text-sm text-neutral-500">
                    Nothing scheduled ahead.
                  </p>
                ) : (
                  <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
                    {detail.upcoming.map((o) => (
                      <li key={o.id} className="flex items-center justify-between px-3 py-2 text-sm">
                        <span className="text-neutral-800">{formatDate(o.scheduledDate)} · {o.deliveryTime}</span>
                        <StatusPill map={DELIVERY_STATUS} value={o.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h3 className="mb-2 text-sm font-semibold text-neutral-900">Past deliveries</h3>
                {detail.recent.length === 0 ? (
                  <p className="rounded-lg bg-neutral-50 px-3 py-4 text-sm text-neutral-500">No history yet.</p>
                ) : (
                  <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
                    {detail.recent.map((o) => (
                      <li key={o.id} className="flex items-center justify-between px-3 py-2 text-sm">
                        <span className="text-neutral-800">{formatDate(o.scheduledDate)} · {o.deliveryTime}</span>
                        <StatusPill map={DELIVERY_STATUS} value={o.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
