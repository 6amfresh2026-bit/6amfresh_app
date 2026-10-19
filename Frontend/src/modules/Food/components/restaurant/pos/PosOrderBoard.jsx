import { useEffect, useState } from "react"
import { Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { usePosApi } from "./posApiContext"
import PosModal from "./PosModal"
import { money, fmtDateTime } from "./posUtils"
import { POS_ORDER_TABS, POS_ORDER_TAB, ORDER_STATUS_LABEL, statusTone } from "./posOrderStatus"

/**
 * The shop's order book, from the till.
 *
 * Deliberately the whole book and not just counter sales: a counter sale is
 * `delivered` the moment it is rung up, so filtered by status it would put
 * every till bill under one tab and leave the other seven empty. What a
 * cashier actually wants to check mid-shift is the app orders — what is
 * scheduled, what a rider has, what is still waiting to be accepted.
 *
 * The tabs are repeated inside so a cashier can move between statuses without
 * closing and reopening from the bar.
 */
export default function PosOrderBoard({ status = "all", onStatus, onClose }) {
  const api = usePosApi()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [reloadToken, setReloadToken] = useState(0)

  const tab = POS_ORDER_TAB[status] || POS_ORDER_TAB.all

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .getOrders({ limit: 100, ...tab.params })
      .then((res) => {
        if (cancelled) return
        const list = res?.data?.data?.orders || res?.data?.orders || []
        setRows(Array.isArray(list) ? list : [])
      })
      .catch((err) => {
        if (!cancelled) toast.error(err?.response?.data?.message || "Could not load orders")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab, reloadToken])

  const total = rows.reduce((sum, o) => sum + (Number(o.pricing?.total ?? o.total) || 0), 0)

  return (
    <PosModal title="Orders" onClose={onClose} width="max-w-5xl">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {POS_ORDER_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => onStatus(t.key)}
            className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
              t.key === status ? "bg-[#FA0272] text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setReloadToken((n) => n + 1)}
          className="ml-auto rounded p-2 text-gray-500 hover:bg-neutral-100"
          title="Reload"
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {loading ? (
        <div className="py-14 text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-neutral-400" />
        </div>
      ) : rows.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-gray-500">Nothing under {tab.label}</p>
          {tab.emptyNote ? <p className="mx-auto mt-2 max-w-md text-xs text-gray-400">{tab.emptyNote}</p> : null}
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-left text-gray-700">
            <tr>
              <th className="px-2 py-2">Order</th>
              <th className="px-2 py-2">Placed</th>
              <th className="px-2 py-2">Customer</th>
              <th className="px-2 py-2">Items</th>
              <th className="px-2 py-2">Source</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const st = o.orderStatus || o.status || ""
              return (
                <tr key={o._id || o.orderId} className="border-b border-gray-100">
                  <td className="px-2 py-2 font-medium">{o.order_id || o.orderId || String(o._id).slice(-6)}</td>
                  <td className="px-2 py-2 text-gray-600">
                    {fmtDateTime(o.scheduledAt || o.createdAt)}
                    {o.scheduledAt ? <span className="ml-1 text-amber-700">(for later)</span> : null}
                  </td>
                  <td className="px-2 py-2">
                    {o.customerName || o.userId?.name || "Customer"}
                    {o.customerPhone ? <span className="text-gray-500"> · {o.customerPhone}</span> : null}
                  </td>
                  <td className="max-w-[220px] truncate px-2 py-2 text-gray-600">
                    {(o.items || []).map((i) => `${i.quantity}x ${i.name}`).join(", ") || "—"}
                  </td>
                  <td className="px-2 py-2 text-gray-600">{o.source === "pos" ? "Counter" : "App"}</td>
                  <td className="px-2 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusTone(st)}`}>
                      {ORDER_STATUS_LABEL[st] || st || "—"}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right">₹{money(o.pricing?.total ?? o.total, 2)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {!loading && rows.length > 0 ? (
        <div className="mt-3 flex items-center justify-between text-sm text-gray-700">
          <span>{rows.length} order{rows.length === 1 ? "" : "s"}</span>
          <span>Total <b>₹{money(total, 2)}</b></span>
        </div>
      ) : null}
    </PosModal>
  )
}
