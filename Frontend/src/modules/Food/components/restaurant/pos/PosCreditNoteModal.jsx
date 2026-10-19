import { useEffect, useState, useCallback } from "react"
import { Loader2, Copy, Check, Ban } from "lucide-react"
import { toast } from "sonner"
import { restaurantAPI } from "@food/api"
import PosModal from "./PosModal"

const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const STATUS_STYLE = {
  active: "bg-emerald-50 text-emerald-700",
  partially_redeemed: "bg-amber-50 text-amber-700",
  redeemed: "bg-gray-100 text-gray-500",
  void: "bg-rose-50 text-rose-600",
}
const STATUS_LABEL = {
  active: "Active",
  partially_redeemed: "Partly used",
  redeemed: "Redeemed",
  void: "Void",
}

/**
 * Credit notes: issue a redeemable balance when goods come back, and see the
 * notes this store has out. Redeeming one happens on the Pay screen (pick
 * "Credit Note" as a payment method and enter the code).
 */
export default function PosCreditNoteModal({ onClose }) {
  const [amount, setAmount] = useState("")
  const [reason, setReason] = useState("")
  const [phone, setPhone] = useState("")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [issued, setIssued] = useState(null) // the note just created
  const [copied, setCopied] = useState(false)
  const [notes, setNotes] = useState([])
  const [loadingList, setLoadingList] = useState(true)

  const loadList = useCallback(async () => {
    setLoadingList(true)
    try {
      const res = await restaurantAPI.posListCreditNotes({ limit: 30 })
      setNotes(res?.data?.data?.creditNotes || res?.data?.creditNotes || [])
    } catch {
      /* a failed list shouldn't block issuing */
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => { loadList() }, [loadList])

  const submit = async () => {
    const amt = Number(amount) || 0
    if (!(amt > 0)) { toast.error("Enter an amount above zero"); return }
    setBusy(true)
    try {
      const res = await restaurantAPI.posIssueCreditNote({
        amount: amt,
        reason: reason.trim(),
        customerPhone: phone.trim(),
        customerName: name.trim(),
      })
      const note = res?.data?.data?.creditNote || res?.data?.creditNote
      setIssued(note)
      setAmount(""); setReason(""); setPhone(""); setName("")
      toast.success(`Credit note ${note?.code} issued`)
      loadList()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not issue the credit note")
    } finally {
      setBusy(false)
    }
  }

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(issued.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard may be blocked — the code is shown anyway */
    }
  }

  const voidNote = async (id) => {
    try {
      await restaurantAPI.posVoidCreditNote(id)
      toast.success("Credit note voided")
      loadList()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not void it")
    }
  }

  return (
    <PosModal
      title="Credit notes"
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <div className="flex items-center justify-end">
          <button
            type="button"
            disabled={busy}
            onClick={submit}
            className="flex items-center gap-2 rounded bg-sky-700 px-6 py-2.5 text-[15px] font-medium text-white hover:bg-sky-800 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? "Issuing…" : "Issue credit note"}
          </button>
        </div>
      }
    >
      <div className="grid gap-5 md:grid-cols-2">
        {/* Issue */}
        <div>
          <h3 className="mb-2 text-[15px] font-semibold text-gray-800">Issue for a return</h3>
          {issued ? (
            <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-emerald-800">Issued</span>
                <button type="button" onClick={copyCode} className="flex items-center gap-1 text-sm text-emerald-700 hover:text-emerald-900">
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="mt-0.5 font-mono text-lg font-semibold text-emerald-900">{issued.code}</div>
              <div className="text-sm text-emerald-700">Balance {inr(issued.balance)}</div>
            </div>
          ) : null}

          <label className="mb-1 block text-[14px] text-gray-700">Amount</label>
          <div className="flex items-center rounded border border-gray-300 focus-within:border-sky-400">
            <span className="px-3 text-[15px] text-gray-500">₹</span>
            <input type="number" min="0" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit() }}
              placeholder="0" className="h-11 w-full rounded-r bg-white px-2 text-[15px] text-gray-800 outline-none" />
          </div>

          <label className="mb-1 mt-3 block text-[14px] text-gray-700">Reason</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. returned 1x damaged item"
            className="h-11 w-full rounded border border-gray-300 bg-white px-3 text-[15px] text-gray-800 outline-none focus:border-sky-400" />

          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[14px] text-gray-700">Customer phone</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional"
                className="h-11 w-full rounded border border-gray-300 bg-white px-3 text-[15px] text-gray-800 outline-none focus:border-sky-400" />
            </div>
            <div>
              <label className="mb-1 block text-[14px] text-gray-700">Customer name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional"
                className="h-11 w-full rounded border border-gray-300 bg-white px-3 text-[15px] text-gray-800 outline-none focus:border-sky-400" />
            </div>
          </div>
          <p className="mt-3 text-[13px] text-gray-500">To redeem one, open Pay and choose <span className="font-medium">Credit Note</span> as a payment method.</p>
        </div>

        {/* Existing notes */}
        <div className="min-w-0">
          <h3 className="mb-2 text-[15px] font-semibold text-gray-800">This store's notes</h3>
          <div className="max-h-[360px] overflow-auto rounded border border-gray-200">
            {loadingList ? (
              <div className="flex items-center justify-center py-8 text-gray-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
            ) : notes.length === 0 ? (
              <div className="py-8 text-center text-sm text-gray-400">No credit notes yet</div>
            ) : (
              <table className="w-full text-[13px]">
                <tbody>
                  {notes.map((n) => {
                    const voidable = n.status === "active" && Number(n.balance) === Number(n.amount)
                    return (
                      <tr key={n._id} className="border-b border-gray-100 last:border-0">
                        <td className="px-2 py-2">
                          <div className="font-mono font-medium text-gray-800">{n.code}</div>
                          {n.customerName || n.customerPhone ? (
                            <div className="text-gray-500">{n.customerName}{n.customerPhone ? ` · ${n.customerPhone}` : ""}</div>
                          ) : null}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <div className="font-semibold text-gray-900">{inr(n.balance)}</div>
                          {Number(n.balance) !== Number(n.amount) ? <div className="text-gray-400">of {inr(n.amount)}</div> : null}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_STYLE[n.status] || "bg-gray-100 text-gray-600"}`}>{STATUS_LABEL[n.status] || n.status}</span>
                        </td>
                        <td className="px-1 py-2 text-right">
                          {voidable ? (
                            <button type="button" onClick={() => voidNote(n._id)} title="Void" className="text-gray-400 hover:text-rose-600"><Ban className="h-4 w-4" /></button>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </PosModal>
  )
}
