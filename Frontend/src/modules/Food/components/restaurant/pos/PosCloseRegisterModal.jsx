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
export default function PosCloseRegisterModal({ summary, onClose, onConfirm, logoutMode = true }) {
  const [counts, setCounts] = useState({})
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState("")
  const [managerId, setManagerId] = useState("")
  const [managerPassword, setManagerPassword] = useState("")

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

  const mismatch = difference !== 0
  const blocked = mismatch && (!reason.trim() || !managerId.trim() || !managerPassword)

  const confirm = async () => {
    if (blocked) return
    setBusy(true)
    try {
      const denominations = {}
      DENOMS.forEach((d) => { const c = Number(counts[d]) || 0; if (c) denominations[d] = c })
      await onConfirm({
        countedCash: counted,
        denominations,
        ...(mismatch ? { reason: reason.trim(), managerId: managerId.trim(), managerPassword } : {})
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <PosModal
      title={
        <div>
          <div>{logoutMode ? "Close register & log out" : "Close register"}</div>
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
        <div className="flex items-center justify-end gap-3">
          {mismatch && (
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-gray-300 bg-white px-5 py-2.5 text-[15px] font-medium text-gray-700 hover:bg-gray-50"
            >
              Back to billing
            </button>
          )}
          <button
            type="button"
            disabled={busy || blocked}
            onClick={confirm}
            className={`rounded px-6 py-2.5 text-[15px] font-medium text-white disabled:opacity-50 flex items-center gap-2 ${mismatch ? "bg-emerald-700 hover:bg-emerald-800" : "bg-[#1f1f1f] hover:bg-black"}`}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? "Closing…" : mismatch ? "Close with difference" : logoutMode ? "Close & log out" : "Close register"}
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
          <span className="text-[17px] font-bold text-gray-900">{inr(counted)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[15px] text-gray-700">
            {difference < 0 ? "Cash short" : difference > 0 ? "Cash over" : "Difference"}
          </span>
          <span className={`text-[15px] font-semibold ${difference < 0 ? "text-rose-600" : difference > 0 ? "text-amber-600" : "text-emerald-600"}`}>
            {difference < 0 ? "−" : difference > 0 ? "+" : ""}{inr(Math.abs(difference))}
          </span>
        </div>
      </div>

      {/* A non-zero drawer needs a reason and a manager's sign-off. */}
      {mismatch && (
        <div className="mt-4 space-y-4">
          <div className="rounded-lg bg-rose-50 p-3">
            <p className="text-sm font-semibold text-rose-700">✗ Cash does not match by {inr(Math.abs(difference))}.</p>
            <p className="mt-0.5 text-xs text-rose-600/90">
              Recount the drawer. If the difference is real, a manager has to approve closing with it.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-[15px] font-medium text-gray-800">Reason for the difference <span className="text-rose-500">*</span></label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. wrong change given to a customer"
              className="h-11 w-full rounded border border-gray-300 bg-white px-3 text-[15px] text-gray-800 outline-none focus:border-sky-400"
            />
          </div>
          <div>
            <label className="mb-1 block text-[15px] font-medium text-gray-800">Manager ID</label>
            <input
              value={managerId}
              onChange={(e) => setManagerId(e.target.value)}
              placeholder="manager@store.com"
              autoComplete="off"
              className="h-11 w-full rounded border border-gray-300 bg-white px-3 text-[15px] text-gray-800 outline-none focus:border-sky-400"
            />
          </div>
          <div>
            <label className="mb-1 block text-[15px] font-medium text-gray-800">Manager password</label>
            <input
              type="password"
              value={managerPassword}
              onChange={(e) => setManagerPassword(e.target.value)}
              autoComplete="new-password"
              className="h-11 w-full rounded border border-gray-300 bg-white px-3 text-[15px] text-gray-800 outline-none focus:border-sky-400"
            />
          </div>
        </div>
      )}
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
