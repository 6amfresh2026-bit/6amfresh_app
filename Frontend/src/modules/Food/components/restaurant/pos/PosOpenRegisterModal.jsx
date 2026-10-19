import { useState } from "react"
import { Loader2 } from "lucide-react"
import PosModal from "./PosModal"

/**
 * Shown when the POS opens with no register running. The cashier enters the
 * cash already in the drawer (the opening float); everything rung up after
 * rolls into this shift until it is closed and counted.
 */
export default function PosOpenRegisterModal({ cashierName, onOpen }) {
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      await onOpen(Math.max(0, Number(amount) || 0))
    } finally {
      setBusy(false)
    }
  }

  return (
    <PosModal
      title="Open register"
      onClose={null}
      width="max-w-md"
      footer={
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="mx-auto block rounded bg-[#1f1f1f] px-8 py-2.5 text-[15px] font-medium text-white hover:bg-black disabled:opacity-50 flex items-center gap-2"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? "Opening…" : "Open register"}
        </button>
      }
    >
      <p className="text-sm text-gray-600">
        {cashierName ? `${cashierName}, s` : "S"}tart the shift by counting the cash already in the drawer.
      </p>
      <div className="mt-4">
        <label className="mb-1.5 block text-[15px] text-gray-800">Opening cash</label>
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
        <p className="mt-1.5 text-xs text-gray-500">
          Leave 0 if the drawer starts empty. You can count the full drawer when you close.
        </p>
      </div>
    </PosModal>
  )
}
