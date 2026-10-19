import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { usePosApi } from "./posApiContext"
import PosModal from "./PosModal"
import { money } from "./posUtils"

/**
 * The coupons this shop can put on the bill.
 *
 * Admin creates them; the till only reads them. Every coupon in scope is
 * listed, including the ones that cannot be used right now — with the reason
 * in place of the Apply button. A coupon that quietly vanishes from the list
 * is one the cashier cannot explain to the customer standing there, and
 * "add ₹120 more and this works" is the difference between a sale and a shrug.
 *
 * The verdicts come from the same rules the pricing engine applies, so an
 * Apply button here is always honoured by the bill.
 */

const sectionHead = "bg-neutral-100 px-3 py-2 text-[15px] font-semibold text-gray-700"

const CouponRow = ({ row, active, onApply }) => (
  <div className="flex items-center gap-3 border-b border-neutral-100 px-3 py-2.5 last:border-b-0">
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[15px] font-medium text-gray-900">{row.code}</span>
        <span className="text-xs text-gray-500">{row.terms}</span>
        {row.createdBy === "You" ? (
          <span className="rounded bg-neutral-100 px-1.5 text-[11px] text-gray-500">yours</span>
        ) : null}
      </div>
      {!row.eligible ? <p className="mt-0.5 text-xs text-amber-700">{row.reason}</p> : null}
      {row.eligible && row.discount > 0 ? (
        <p className="mt-0.5 text-xs text-emerald-700">Saves ₹{money(row.discount, 2)}</p>
      ) : null}
    </div>

    {active ? (
      <button
        type="button"
        onClick={() => onApply("")}
        className="shrink-0 rounded bg-neutral-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800"
      >
        Remove
      </button>
    ) : (
      <button
        type="button"
        disabled={!row.eligible}
        onClick={() => onApply(row.code)}
        className="shrink-0 rounded bg-emerald-500 px-5 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400"
      >
        Apply
      </button>
    )}
  </div>
)

export default function PosCouponModal({ current, invoiceBalance, items, customerId, onClose, onApply }) {
  const api = usePosApi()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .posCoupons({ items, customerId: customerId || undefined })
      .then((res) => {
        if (!cancelled) setData(res?.data?.data || null)
      })
      .catch((err) => {
        if (!cancelled) toast.error(err?.response?.data?.message || "Could not load coupons")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [items, customerId])

  // Filtering client-side keeps typing instant; the list is a shop's coupons,
  // not a catalogue, so it is already in hand.
  const match = (r) => !search.trim() || r.code.toLowerCase().includes(search.trim().toLowerCase())
  const general = (data?.coupons || []).filter(match)
  const customerScoped = (data?.customerCoupons || []).filter(match)

  return (
    <PosModal title="Apply Coupon" onClose={onClose} width="max-w-xl">
      <div className="mb-3 flex justify-center">
        <span className="rounded bg-[#2b2b2b] px-4 py-1.5 text-[15px] font-medium text-white">
          Invoice Balance: {money(invoiceBalance, 2)}
        </span>
      </div>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search a coupon code"
        className="mb-3 h-10 w-full rounded border border-gray-300 px-3 text-sm outline-none focus:border-sky-400"
        autoFocus
      />

      {loading ? (
        <div className="py-12 text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-neutral-400" />
        </div>
      ) : (
        <div className="rounded border border-neutral-200">
          <div className={sectionHead}>Coupon Name</div>
          {general.length === 0 ? (
            <p className="px-3 py-5 text-center text-sm text-gray-500">
              {search.trim() ? `No coupon matches "${search.trim()}"` : "Admin has not set up any coupon for this store yet"}
            </p>
          ) : (
            general.map((row) => (
              <CouponRow key={row.id} row={row} active={current === row.code} onApply={onApply} />
            ))
          )}

          <div className={`${sectionHead} border-t border-neutral-200`}>Customer Coupon</div>
          {customerScoped.length === 0 ? (
            <p className="px-3 py-5 text-center text-sm text-gray-500">
              No coupon here depends on who the customer is
            </p>
          ) : (
            customerScoped.map((row) => (
              <CouponRow key={row.id} row={row} active={current === row.code} onApply={onApply} />
            ))
          )}
        </div>
      )}

      {!loading && !data?.hasCustomer && customerScoped.some((c) => !c.eligible) ? (
        <p className="mt-3 rounded bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
          Pick a customer on the sale screen to use the coupons above — they depend on that customer's history.
        </p>
      ) : null}
    </PosModal>
  )
}
