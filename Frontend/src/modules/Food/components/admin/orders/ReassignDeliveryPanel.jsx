import { useCallback, useEffect, useState } from "react"
import { Loader2, MapPin, Package, RefreshCw, X } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"

/**
 * Moving a live order from one rider to another.
 *
 * The decision needs four things on screen at once — who has it now, who else
 * could take it, how far away each of them is, and whether they are actually
 * open to work — because picking from a list of names alone is how an order
 * lands on somebody who is on a break three kilometres away.
 *
 * The reason is mandatory and is not a free-text afterthought: it is the only
 * part of this that survives usefully into the history, and "reassigned" with
 * no reason answers nothing when the payout is queried a week later.
 */

const REASONS = [
  "Rider went on break",
  "Washroom break",
  "Emergency",
  "Vehicle problem",
  "Cannot collect the order",
  "Rider became unavailable",
  "Rider too far from the store",
]

const STATUS_STYLE = {
  Online: "bg-emerald-100 text-emerald-800",
  Offline: "bg-neutral-200 text-neutral-700",
}

const pauseStyle = "bg-amber-100 text-amber-800"

const dateTime = (value) => {
  if (!value) return "—"
  const d = new Date(value)
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
}

export default function ReassignDeliveryPanel({ order, onClose, onDone }) {
  const orderId = String(order?._id || order?.orderObjectId || "")

  const [riders, setRiders] = useState([])
  const [history, setHistory] = useState([])
  const [pickupKnown, setPickupKnown] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [selected, setSelected] = useState("")
  const [reason, setReason] = useState("")
  const [customReason, setCustomReason] = useState("")
  const [error, setError] = useState("")

  const current = riders.find((r) => r.isCurrent) || null

  const load = useCallback(async () => {
    if (!orderId) return
    setLoading(true)
    try {
      const res = await adminAPI.getAssignableRiders(orderId)
      const data = res?.data?.data || {}
      setRiders(Array.isArray(data.riders) ? data.riders : [])
      // Comes back with the picker so the panel never has to guess at the
      // shape of whatever the parent screen happened to hold.
      setHistory(Array.isArray(data.history) ? data.history : [])
      setPickupKnown(data.pickupKnown !== false)
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not load delivery partners")
      setRiders([])
    } finally {
      setLoading(false)
    }
  }, [orderId])

  useEffect(() => {
    load()
  }, [load])

  const finalReason = reason === "Other" ? customReason.trim() : reason

  const confirm = async () => {
    setError("")
    if (!selected) return setError("Choose a delivery partner")
    if (!finalReason || finalReason.length < 3) return setError("Give a reason for the reassignment")

    setSaving(true)
    try {
      const res = await adminAPI.reassignOrderToRider(orderId, selected, finalReason)
      const data = res?.data?.data
      toast.success(
        data?.from?.name
          ? `Moved from ${data.from.name} to ${data.to.name}`
          : `Assigned to ${data?.to?.name || "the rider"}`,
      )
      onDone?.(data)
      onClose?.()
    } catch (err) {
      setError(err?.response?.data?.message || "Reassignment failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onMouseDown={() => !saving && onClose?.()}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-neutral-200 px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-neutral-900">Reassign delivery</h3>
            <p className="text-sm text-neutral-500">
              Order {order?.order_id || order?.orderId || orderId}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onClose?.()}
            disabled={saving}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-4 rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Currently with
            </div>
            {current ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-neutral-900">{current.name}</span>
                <span className="text-neutral-500">{current.phone}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                    STATUS_STYLE[current.availabilityLabel] || pauseStyle
                  }`}
                >
                  {current.availabilityLabel}
                </span>
              </div>
            ) : (
              <span className="text-neutral-600">Nobody — this order has no rider right now.</span>
            )}
          </div>

          <div className="mb-4">
            <label className="mb-1 block text-sm font-semibold text-neutral-800">Reason</label>
            <select
              value={reason}
              onChange={(e) => {
                setReason(e.target.value)
                setError("")
              }}
              className="h-10 w-full rounded border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-blue-500"
            >
              <option value="">Select a reason…</option>
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
              <option value="Other">Other…</option>
            </select>
            {reason === "Other" && (
              <input
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                placeholder="What happened?"
                className="mt-2 h-10 w-full rounded border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-blue-500"
              />
            )}
          </div>

          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-semibold text-neutral-800">Available delivery partners</label>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-1 text-sm text-blue-600 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
            </button>
          </div>

          {!pickupKnown && (
            /* Without a pickup point every distance would be a guess, and a
               guessed distance is worse than none: it reads as fact. */
            <p className="mb-2 text-xs text-amber-700">
              This store has no saved location, so distances cannot be shown.
            </p>
          )}

          <div className="overflow-hidden rounded-lg border border-neutral-200">
            {loading ? (
              <div className="grid place-items-center py-10 text-neutral-400">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : riders.length === 0 ? (
              <div className="py-10 text-center text-sm text-neutral-500">
                No delivery partners available.
              </div>
            ) : (
              <ul className="divide-y divide-neutral-100">
                {riders.map((r) => {
                  const id = String(r._id)
                  const disabled = r.isCurrent
                  return (
                    <li key={id}>
                      <label
                        className={`flex cursor-pointer items-center gap-3 px-3 py-2.5 ${
                          disabled ? "cursor-not-allowed opacity-50" : "hover:bg-neutral-50"
                        } ${selected === id ? "bg-blue-50" : ""}`}
                      >
                        <input
                          type="radio"
                          name="reassign-rider"
                          value={id}
                          disabled={disabled}
                          checked={selected === id}
                          onChange={() => {
                            setSelected(id)
                            setError("")
                          }}
                          className="h-4 w-4"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-neutral-900">{r.name || "Unnamed"}</span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                                STATUS_STYLE[r.availabilityLabel] || pauseStyle
                              }`}
                            >
                              {r.availabilityLabel}
                            </span>
                            {r.isSellerFleet && (
                              <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800">
                                Seller&apos;s fleet
                              </span>
                            )}
                            {r.isCurrent && (
                              <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-xs text-neutral-700">
                                Has this order
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-neutral-500">
                            <span>{r.phone}</span>
                            <span className="inline-flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              {r.distanceKm === null || r.distanceKm === undefined
                                ? "location unknown"
                                : `${r.distanceKm} km from store`}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Package className="h-3 w-3" />
                              {r.activeOrderCount} active
                            </span>
                          </div>
                        </div>
                        {!r.isDispatchable && !r.isCurrent && (
                          /* Choosable, but never silently: dispatch would not
                             pick this rider on its own. */
                          <span className="shrink-0 text-xs text-amber-700">not taking orders</span>
                        )}
                      </label>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {history.length > 0 && (
            <div className="mt-5">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Reassignment history
              </h4>
              <ul className="space-y-1.5 text-sm">
                {history.map((h, i) => (
                  <li key={i} className="rounded border border-neutral-200 px-3 py-2">
                    <div className="text-neutral-800">
                      {h.fromName || "Unassigned"} → {h.toName || "—"}
                    </div>
                    <div className="text-xs text-neutral-500">
                      {dateTime(h.at)} · {h.byRole || "ADMIN"} · {h.reason}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3">
          <button
            type="button"
            onClick={() => onClose?.()}
            disabled={saving}
            className="rounded border border-neutral-300 px-4 py-2 text-sm text-neutral-700 disabled:opacity-60"
          >
            Cancel reassignment
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={saving || loading}
            className="inline-flex items-center gap-2 rounded bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Confirm
          </button>
        </div>
      </div>
    </div>
  )
}
