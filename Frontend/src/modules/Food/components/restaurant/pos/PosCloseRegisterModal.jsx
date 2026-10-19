import { useMemo, useState } from "react"
import { Loader2 } from "lucide-react"
import PosModal from "./PosModal"

const DENOMS = [500, 200, 100, 50, 20, 10, 5, 2, 1]

const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`

/**
 * The end-of-shift drawer count. Shows what the till expects (opening float +
 * cash sales + received − out − refunds) against what the cashier counts, and
 * the difference. Confirming closes the register and logs out.
 *
 * `summary` is the open shift from GET /pos/shift/summary.
 */
export default function PosCloseRegisterModal({ summary, onClose, onConfirm }) {
  const [counts, setCounts] = useState({})
  const [busy, setBusy] = useState(false)

  const openingCash = Number(summary?.openingCash || 0)
  const cashSales = Number(summary?.cashSales || 0)
  const billsCount = Number(summary?.billsCount || 0)
  const received = Number(summary?.cashReceived || 0)
  const out = Number(summary?.cashOut || 0)
  const refunds = Number(summary?.refunds || 0)
  const netCash = cashSales + received - out - refunds
  const expected = Number(summary?.expectedCash ?? openingCash + netCash)

  const counted = useMemo(
    () => DENOMS.reduce((sum, d) => sum + d * (Number(counts[d]) || 0), 0),
    [counts]
  )
  const difference = counted - expected

  const confirm = async () => {
    setBusy(true)
    try {
      const denominations = {}
      DENOMS.forEach((d) => { const c = Number(counts[d]) || 0; if (c) denominations[d] = c })
      await onConfirm({ countedCash: counted, denominations })
    } finally {
      setBusy(false)
    }
  }

  return (
    <PosModal
      title={
        <div>
          <div>Close register &amp; log out</div>
          {(summary?.shiftCode || summary?.cashierName) && (
            <div className="text-xs font-normal text-gray-500">
              {[summary?.shiftCode, summary?.cashierName].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
      }
      onClose={onClose}
      width="max-w-lg"
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm">
            <span className="text-gray-500">Difference </span>
            <span className={`font-semibold ${difference < 0 ? "text-rose-600" : difference > 0 ? "text-amber-600" : "text-emerald-600"}`}>
              {difference < 0 ? "−" : difference > 0 ? "+" : ""}{inr(Math.abs(difference))}
            </span>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={confirm}
            className="rounded bg-[#1f1f1f] px-6 py-2.5 text-[15px] font-medium text-white hover:bg-black disabled:opacity-50 flex items-center gap-2"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? "Closing…" : "Close & log out"}
          </button>
        </div>
      }
    >
      {/* Expected cash breakdown */}
      <div className="rounded-lg bg-gray-50 p-4">
        <Row label="Opening cash" value={inr(openingCash)} />
        <Row label="Bills · sales" value={`${billsCount} · ${inr(cashSales)}`} bold />
        <Row label="Cash sales + received − out − refunds" value={inr(netCash)} />
        <div className="mt-2 border-t pt-2 flex items-center justify-between">
          <span className="text-[15px] font-bold text-gray-900">Expected cash in drawer</span>
          <span className="text-[17px] font-bold text-gray-900">{inr(expected)}</span>
        </div>
      </div>

      {/* Count */}
      <p className="mt-4 mb-2 text-[15px] font-semibold text-gray-900">Count the cash now</p>
      <div className="space-y-2">
        {DENOMS.map((d) => (
          <div key={d} className="flex items-center gap-3">
            <span className="w-12 shrink-0 text-right text-sm font-medium text-gray-700">₹{d}</span>
            <input
              type="number"
              min="0"
              value={counts[d] ?? ""}
              onChange={(e) => setCounts((c) => ({ ...c, [d]: e.target.value }))}
              placeholder="0"
              className="h-10 flex-1 rounded border border-gray-300 bg-white px-3 text-right text-[15px] text-gray-800 outline-none focus:border-sky-400"
            />
            <span className="w-16 shrink-0 text-right text-sm text-gray-600">{inr(d * (Number(counts[d]) || 0))}</span>
          </div>
        ))}
      </div>

      {/* Counted + difference */}
      <div className="mt-4 rounded-lg bg-gray-50 p-4">
        <div className="flex items-center justify-between">
          <span className="text-[15px] text-gray-700">Counted</span>
          <span className="text-[16px] font-bold text-gray-900">{inr(counted)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[15px] text-gray-700">Difference</span>
          <span className={`text-[15px] font-semibold ${difference < 0 ? "text-rose-600" : difference > 0 ? "text-amber-600" : "text-emerald-600"}`}>
            {difference < 0 ? "−" : difference > 0 ? "+" : ""}{inr(Math.abs(difference))}
          </span>
        </div>
      </div>
    </PosModal>
  )
}

function Row({ label, value, bold }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-sm text-gray-600">{label}</span>
      <span className={`text-sm ${bold ? "font-semibold text-gray-900" : "text-gray-800"}`}>{value}</span>
    </div>
  )
}
