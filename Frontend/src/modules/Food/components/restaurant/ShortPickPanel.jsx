import { useState, useEffect, useCallback } from "react"
import { toast } from "sonner"
import { Loader2, Minus, Plus, RefreshCw } from "lucide-react"
import { restaurantAPI } from "@food/api"

const RUPEE = "₹"

/**
 * What the picker actually found.
 *
 * Groceries go short, and until this screen existed the only answers a seller
 * could give were "deliver everything" or "cancel the whole order" — neither of
 * which is what happens at a shelf. The customer wanted ten things, nine are
 * there, and they would like those nine.
 *
 * Only the exceptions are sent. A line the picker does not touch is assumed
 * found in full, so the common case is a single tap on one row rather than
 * confirming every line of the basket.
 */
export default function ShortPickPanel({ orderId, items = [], substitutionPreference = "refund", onAdjusted }) {
  // Keyed by itemId: what the picker says is actually there.
  const [found, setFound] = useState({})
  const [subsFor, setSubsFor] = useState(null)
  const [subs, setSubs] = useState([])
  const [loadingSubs, setLoadingSubs] = useState(false)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState("")

  const canSwap = substitutionPreference === "allow"

  useEffect(() => {
    const start = {}
    for (const line of items) start[String(line.itemId)] = Number(line.quantity) || 0
    setFound(start)
  }, [items])

  const setQty = (itemId, qty, max) => {
    setFound((prev) => ({ ...prev, [itemId]: Math.max(0, Math.min(max, qty)) }))
  }

  const openSubs = useCallback(async (line) => {
    if (subsFor === String(line.itemId)) { setSubsFor(null); return }
    setSubsFor(String(line.itemId))
    setLoadingSubs(true)
    try {
      const res = await restaurantAPI.getItemSubstitutes(line.itemId)
      setSubs(res?.data?.data?.substitutes || [])
    } catch {
      // An empty list and the message below are the same useful answer whether
      // the call failed or nothing is nominated: offer a refund instead.
      setSubs([])
    } finally {
      setLoadingSubs(false)
    }
  }, [subsFor])

  /** Lines whose count the picker changed — the only ones worth sending. */
  const changed = items.filter((l) => Number(found[String(l.itemId)]) !== (Number(l.quantity) || 0))

  const submit = async (lines, successNote) => {
    setSaving(true)
    try {
      const res = await restaurantAPI.adjustOrderFulfilment(orderId, lines, note)
      const data = res?.data?.data
      const refunded = Number(data?.refund?.amount) || 0
      const due = Number(data?.amountDue) || 0
      toast.success(successNote, {
        description: refunded > 0
          ? `${RUPEE}${refunded} refunded — new total ${RUPEE}${data?.pricing?.total}`
          : `Collect ${RUPEE}${due} on delivery`,
      })
      setSubsFor(null)
      onAdjusted?.(data)
    } catch (err) {
      // The server's refusal names the rule that was broken — the customer
      // asked for a refund, the rider already collected, nothing would be left.
      // It is far more useful than anything this panel could invent.
      toast.error(err?.response?.data?.message || "Could not update the order")
    } finally {
      setSaving(false)
    }
  }

  const applyShortPicks = () =>
    submit(
      changed.map((l) => ({ itemId: String(l.itemId), fulfilledQuantity: Number(found[String(l.itemId)]) })),
      "Order updated for what was picked",
    )

  const swap = (line, replacement) =>
    submit(
      [{ itemId: String(line.itemId), substituteItemId: String(replacement.id), quantity: Number(line.quantity) || 1 }],
      `Sent ${replacement.name} instead`,
    )

  if (items.length === 0) return null

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3" data-testid="short-pick-panel">
      <div className="mb-2">
        <p className="text-[11px] font-bold text-gray-800">Short of something?</p>
        <p className="text-[10px] text-gray-500">
          Set what is actually on the shelf. Anything you do not touch is sent in full.
        </p>
      </div>

      <div className="space-y-1.5">
        {items.map((line) => {
          const id = String(line.itemId)
          const ordered = Number(line.quantity) || 0
          const have = Number(found[id] ?? ordered)
          const short = have < ordered
          return (
            <div key={id} className="rounded-lg bg-white px-2.5 py-2" data-testid={`pick-row-${id}`}>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-semibold text-gray-900">{line.name}</p>
                  <p className="text-[10px] text-gray-500">
                    {ordered} ordered · {RUPEE}{line.price}
                    {short ? <span className="ml-1 font-semibold text-amber-700">{ordered - have} short</span> : null}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    aria-label={`One fewer ${line.name}`}
                    data-testid={`pick-minus-${id}`}
                    onClick={() => setQty(id, have - 1, ordered)}
                    disabled={have <= 0 || saving}
                    className="flex h-7 w-7 items-center justify-center rounded-full border border-gray-300 text-gray-700 disabled:opacity-30"
                  >
                    <Minus className="h-3 w-3" />
                  </button>
                  <span className="w-5 text-center text-[12px] font-bold tabular-nums" data-testid={`pick-qty-${id}`}>{have}</span>
                  <button
                    type="button"
                    aria-label={`One more ${line.name}`}
                    onClick={() => setQty(id, have + 1, ordered)}
                    disabled={have >= ordered || saving}
                    className="flex h-7 w-7 items-center justify-center rounded-full border border-gray-300 text-gray-700 disabled:opacity-30"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => openSubs(line)}
                  disabled={saving}
                  title={canSwap
                    ? "Send something else instead"
                    : "This customer asked for a refund rather than a substitute"}
                  data-testid={`pick-swap-${id}`}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gray-300 text-gray-600 disabled:opacity-30"
                >
                  <RefreshCw className="h-3 w-3" />
                </button>
              </div>

              {subsFor === id ? (
                <div className="mt-2 border-t border-gray-100 pt-2">
                  {!canSwap ? (
                    // Said here rather than after a rejected save: the picker
                    // should not pick a replacement and only then be refused.
                    <p className="text-[10px] font-medium text-amber-700">
                      This customer asked for a refund instead of substitutions. Reduce the count instead.
                    </p>
                  ) : loadingSubs ? (
                    <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                  ) : subs.length === 0 ? (
                    <p className="text-[10px] text-gray-500">
                      No replacement is listed for this product. Reduce the count and it will be refunded.
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {subs.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          disabled={!s.inStock || saving}
                          onClick={() => swap(line, s)}
                          data-testid={`swap-to-${s.id}`}
                          className="flex w-full items-center justify-between rounded-lg border border-gray-200 px-2 py-1.5 text-left disabled:opacity-40"
                        >
                          <span className="truncate text-[11px] font-medium text-gray-800">
                            {s.name} {s.packSize ? <span className="text-gray-400">{s.packSize}</span> : null}
                          </span>
                          <span className="shrink-0 text-[10px] font-semibold text-gray-600">
                            {RUPEE}{s.price}{s.inStock ? "" : " · out of stock"}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note for the customer (optional)"
        className="mt-2 h-8 w-full rounded-lg border border-gray-300 px-2 text-[11px]"
      />

      <button
        type="button"
        onClick={applyShortPicks}
        disabled={changed.length === 0 || saving}
        data-testid="short-pick-apply"
        className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-gray-900 text-[11px] font-bold text-white disabled:opacity-40"
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {changed.length === 0
          ? "Nothing short"
          : `Confirm ${changed.length} short line${changed.length > 1 ? "s" : ""}`}
      </button>
    </div>
  )
}
