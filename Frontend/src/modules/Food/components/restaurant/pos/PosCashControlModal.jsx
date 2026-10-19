import { useState } from "react"
import { Loader2, ArrowDownToLine, ArrowUpFromLine } from "lucide-react"
import { toast } from "sonner"
import { usePosApi } from "./posApiContext"
import PosModal from "./PosModal"

const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * Cash control: record money paid into (float top-up) or out of (petty cash,
 * supplier payment, bank drop) the open drawer during the shift. These feed
 * the close-register maths ("cash sales + received − out − refunds").
 */
export default function PosCashControlModal({ summary, onClose, onUpdated }) {
  const api = usePosApi()
  const [type, setType] = useState("in")
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [shift, setShift] = useState(summary || null)

  const received = Number(shift?.cashReceived || 0)
  const out = Number(shift?.cashOut || 0)
  const inDrawer = Number(shift?.expectedCash ?? 0)

  const submit = async () => {
    const amt = Number(amount) || 0
    if (!(amt > 0)) { toast.error("Enter an amount above zero"); return }
    setBusy(true)
    try {
      const res = await api.posCashMovement({ type, amount: amt, note: note.trim() })
      const updated = res?.data?.data?.shift || null
      setShift(updated)
      onUpdated?.(updated)
      setAmount(""); setNote("")
      toast.success(type === "in" ? "Cash paid in" : "Cash paid out")
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not record the movement")
    } finally {
      setBusy(false)
    }
  }

  return (
    <PosModal
      title={
        <div>
          <div>Cash control</div>
          {shift?.shiftCode && <div className="text-xs font-normal text-gray-500">{shift.shiftCode}</div>}
        </div>
      }
      onClose={onClose}
      width="max-w-md"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-gray-500">In drawer: <span className="font-semibold text-gray-900">{inr(inDrawer)}</span></span>
          <button
            type="button"
            disabled={busy}
            onClick={submit}
            className={`rounded px-6 py-2.5 text-[15px] font-medium text-white disabled:opacity-50 flex items-center gap-2 ${type === "in" ? "bg-emerald-700 hover:bg-emerald-800" : "bg-rose-700 hover:bg-rose-800"}`}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? "Saving…" : type === "in" ? "Pay in" : "Pay out"}
          </button>
        </div>
      }
    >
      <div className="rounded-lg bg-gray-50 p-3 text-sm">
        <div className="flex items-center justify-between py-0.5"><span className="text-gray-600">Paid in so far</span><span className="font-medium text-emerald-700">{inr(received)}</span></div>
        <div className="flex items-center justify-between py-0.5"><span className="text-gray-600">Paid out so far</span><span className="font-medium text-rose-700">{inr(out)}</span></div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setType("in")}
          className={`flex items-center justify-center gap-2 rounded border py-2.5 text-[15px] font-medium ${type === "in" ? "border-emerald-600 bg-emerald-50 text-emerald-700" : "border-gray-300 bg-white text-gray-700"}`}
        >
          <ArrowDownToLine className="h-4 w-4" /> Pay in
        </button>
        <button
          type="button"
          onClick={() => setType("out")}
          className={`flex items-center justify-center gap-2 rounded border py-2.5 text-[15px] font-medium ${type === "out" ? "border-rose-600 bg-rose-50 text-rose-700" : "border-gray-300 bg-white text-gray-700"}`}
        >
          <ArrowUpFromLine className="h-4 w-4" /> Pay out
        </button>
      </div>

      <div className="mt-4">
        <label className="mb-1 block text-[15px] text-gray-800">Amount</label>
        <div className="flex items-center rounded border border-gray-300 focus-within:border-sky-400">
          <span className="px-3 text-[15px] text-gray-500">₹</span>
          <input
            type="number"
            min="0"
            autoFocus
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit() }}
            placeholder="0"
            className="h-11 w-full rounded-r bg-white px-2 text-[15px] text-gray-800 outline-none"
          />
        </div>
      </div>
      <div className="mt-3">
        <label className="mb-1 block text-[15px] text-gray-800">Note</label>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={type === "in" ? "e.g. float top-up" : "e.g. supplier payment, bank drop"}
          className="h-11 w-full rounded border border-gray-300 bg-white px-3 text-[15px] text-gray-800 outline-none focus:border-sky-400"
        />
      </div>
    </PosModal>
  )
}
