import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Printer } from "lucide-react"
import { usePosApi } from "./posApiContext"
import PosModal, { btnDark, btnLight, inputCls } from "./PosModal"
import { fmtDateTime, money, printReceipt, TENDER_LABEL } from "./posUtils"

/**
 * Today's counter sales ("Orders"), or the ones still owed ("Payments"),
 * which is also where a payment is added against a pay-later bill.
 */
export default function PosOrdersModal({ mode = "orders", onClose, onPaid }) {
  const api = usePosApi()
  const dueOnly = mode === "payments"
  const today = new Date().toISOString().slice(0, 10)
  const [date, setDate] = useState(dueOnly ? "all" : today)
  const [data, setData] = useState({ items: [], total: 0, due: 0 })
  const [loading, setLoading] = useState(true)
  const [paying, setPaying] = useState(null) // { id, billNo, due }

  const load = async () => {
    setLoading(true)
    try {
      const res = await api.posListOrders({ date, due: dueOnly ? "true" : undefined, limit: 200 })
      setData(res?.data?.data || { items: [], total: 0, due: 0 })
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not load bills")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [date]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PosModal
      title={dueOnly ? "Payments — bills with a balance due" : "Orders"}
      onClose={onClose}
      width="max-w-5xl"
      footer={
        <div className="flex items-center justify-between text-sm text-gray-700">
          <span>{data.items.length} bill{data.items.length === 1 ? "" : "s"}</span>
          <span>Total <b>₹{money(data.total, 2)}</b>{data.due ? <> · Due <b className="text-red-600">₹{money(data.due, 2)}</b></> : null}</span>
        </div>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <label className="text-gray-600">Date</label>
        <input type="date" className={`${inputCls} w-44`} value={date === "all" ? "" : date} onChange={(e) => setDate(e.target.value || "all")} />
        <button type="button" className={btnLight} onClick={() => setDate("all")}>All dates</button>
        <button type="button" className={btnLight} onClick={() => setDate(today)}>Today</button>
      </div>

      {loading ? <p className="py-8 text-center text-gray-500">Loading…</p> : data.items.length === 0 ? (
        <p className="py-8 text-center text-gray-500">{dueOnly ? "Nothing is owed" : "No counter sales for this date"}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-left text-gray-700">
            <tr>
              <th className="px-2 py-2">Bill No</th>
              <th className="px-2 py-2">Time</th>
              <th className="px-2 py-2">Customer</th>
              <th className="px-2 py-2">Type</th>
              <th className="px-2 py-2">Paid by</th>
              <th className="px-2 py-2 text-right">Amount</th>
              <th className="px-2 py-2 text-right">Due</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.id} className="border-b border-gray-100">
                <td className="px-2 py-2 font-medium">{r.billNo}</td>
                <td className="px-2 py-2">{fmtDateTime(r.createdAt)}</td>
                <td className="px-2 py-2">{r.customer?.name}{r.customer?.phone ? <span className="text-gray-500"> · {r.customer.phone}</span> : null}</td>
                <td className="px-2 py-2">{r.orderTypeLabel}{r.tableNo ? ` · ${r.tableNo}` : ""}</td>
                <td className="px-2 py-2">{TENDER_LABEL[r.payment?.mode] || r.payment?.mode}</td>
                <td className="px-2 py-2 text-right">₹{money(r.pricing?.total, 2)}</td>
                <td className={`px-2 py-2 text-right ${r.payment?.dueAmount ? "font-semibold text-red-600" : "text-gray-400"}`}>{r.payment?.dueAmount ? `₹${money(r.payment.dueAmount, 2)}` : "-"}</td>
                <td className="px-2 py-2 text-right">
                  <div className="flex justify-end gap-1">
                    {r.payment?.dueAmount > 0 ? (
                      <button type="button" className={btnDark} onClick={() => setPaying({ id: r.id, billNo: r.billNo, due: r.payment.dueAmount })}>Add Payment</button>
                    ) : null}
                    <button type="button" className={btnLight} onClick={() => printReceipt(r)} title="Print"><Printer size={14} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {paying ? (
        <AddPayment
          bill={paying}
          onClose={() => setPaying(null)}
          onDone={() => { setPaying(null); load(); onPaid?.() }}
        />
      ) : null}
    </PosModal>
  )
}

function AddPayment({ bill, onClose, onDone }) {
  const [mode, setMode] = useState("cash")
  const [amount, setAmount] = useState(String(bill.due))
  const [busy, setBusy] = useState(false)
  const value = Number(amount) || 0
  const valid = value > 0 && value <= bill.due + 0.005

  const submit = async () => {
    setBusy(true)
    try {
      const res = await api.posRecordPayment(bill.id, { mode, amount: value })
      const d = res?.data?.data
      toast.success(d?.settled ? `Bill ${bill.billNo} settled` : `₹${money(value, 2)} received · ₹${money(d?.dueAmount, 2)} still due`)
      onDone()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not record the payment")
    } finally {
      setBusy(false)
    }
  }

  return (
    <PosModal
      title={`Add payment — ${bill.billNo}`}
      onClose={onClose}
      width="max-w-sm"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className={btnLight} onClick={onClose}>Cancel</button>
          <button type="button" className={btnDark} disabled={!valid || busy} onClick={submit}>Receive</button>
        </div>
      }
    >
      <p className="mb-3 text-gray-600">Balance due <b className="text-gray-900">₹{money(bill.due, 2)}</b></p>
      <div className="mb-3 grid grid-cols-3 gap-1">
        {["cash", "upi", "card"].map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)} className={`rounded border px-2 py-2 ${mode === m ? "border-sky-500 bg-sky-50 text-sky-700" : "border-gray-300 text-gray-700"}`}>
            {TENDER_LABEL[m]}
          </button>
        ))}
      </div>
      <input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus />
      {!valid && amount ? <p className="mt-1 text-xs text-red-500">Enter an amount up to ₹{money(bill.due, 2)}</p> : null}
    </PosModal>
  )
}
