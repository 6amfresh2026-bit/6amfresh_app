import { useMemo, useState } from "react"
import { PanelLeft, X, Plus, ArrowRight } from "lucide-react"
import { money, round2 } from "./posUtils"

/**
 * The Pay screen — what "Multiple Pay" opens.
 *
 * The bill is summarised on the left; on the right the cashier lists what
 * was received, in whatever mix. Short of the bill, the rest is a due (the
 * red note says so before they commit); over it, the change to hand back is
 * shown large. Everything typed into a card row travels as the tender's note,
 * so the receipt and the ledger keep the reference.
 */

const METHODS = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "upi", label: "UPI" },
  { value: "credit_note", label: "Credit Note" },
  { value: "loyalty", label: "Loyalty Points" },
  { value: "wallet", label: "Wallet", disabled: true },
  { value: "bank", label: "Bank", disabled: true },
  { value: "cheque", label: "Cheque", disabled: true },
]

const field = "h-11 w-full rounded border border-gray-300 bg-white px-3 text-[15px] text-gray-800 outline-none focus:border-sky-400"
const label = "mb-1 block text-[15px] text-gray-800"

export default function PosPayScreen({ quote, customer, bankAccount, busy, onBack, onProceed, onLookupCreditNote, loyaltyBalance = 0, loyaltyConfig }) {
  const payable = round2(quote?.pricing?.total)
  const [rows, setRows] = useState([{ mode: "cash", amount: String(payable), holder: "", txn: "", account: "", code: "", cn: null, cnErr: "" }])

  const received = useMemo(() => round2(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)), [rows])
  const change = round2(Math.max(0, received - payable))
  const due = round2(Math.max(0, payable - received))
  // Change is cash handed back, so a credit-note tender can never fund it.
  const cashIn = round2(rows.filter((r) => r.mode === "cash").reduce((s, r) => s + (Number(r.amount) || 0), 0))
  const changeNeedsCash = change > cashIn + 0.001
  // Every credit-note row needs a looked-up code with enough balance before we
  // let the sale go — the backend enforces this too, but catching it here
  // spares the cashier a bounced bill.
  const creditNotesOk = rows.every((r) => r.mode !== "credit_note" || (r.cn && Number(r.amount) <= round2(r.cn.balance) + 0.001))
  // Points redeem at a fixed rate, with a floor (no trivial redemptions) and a
  // ceiling (points can't settle a whole bill); the backend enforces both too.
  const perPoint = Number(loyaltyConfig?.redeemRupeePerPoint) || 1
  const minRedeem = Number(loyaltyConfig?.minRedeemPoints) || 0
  const maxFraction = Number(loyaltyConfig?.maxRedeemBillFraction) || 1
  const loyaltyUsed = round2(rows.filter((r) => r.mode === "loyalty").reduce((s, r) => s + (Number(r.amount) || 0), 0))
  const loyaltyCap = round2(payable * maxFraction)
  const loyaltyOk = rows.every((r) => r.mode !== "loyalty" || (
    customer &&
    Math.round(Number(r.amount) / perPoint) <= loyaltyBalance &&
    Math.round(Number(r.amount) / perPoint) >= minRedeem
  )) && loyaltyUsed <= loyaltyCap + 0.001
  const canProceed = rows.every((r) => Number(r.amount) > 0) && received > 0 && !changeNeedsCash && !(due > 0 && !customer) && creditNotesOk && loyaltyOk && !busy

  const update = (i, patch) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const remove = (i) => setRows((rs) => (rs.length === 1 ? rs : rs.filter((_, idx) => idx !== i)))
  const addRow = () => setRows((rs) => [...rs, { mode: rs.some((r) => r.mode === "upi") ? "card" : "upi", amount: String(due || 0), holder: "", txn: "", account: "", code: "", cn: null, cnErr: "" }])

  // Look a credit note up on demand so the cashier sees its balance before
  // committing; the row keeps the result (or the reason it failed).
  const checkCode = async (i, code) => {
    const clean = String(code || "").trim().toUpperCase()
    if (!clean) return update(i, { cn: null, cnErr: "" })
    try {
      const note = await onLookupCreditNote?.(clean)
      if (!note) return update(i, { cn: null, cnErr: "Not found" })
      if (note.status === "void" || note.balance <= 0) return update(i, { cn: null, cnErr: note.status === "void" ? "Voided" : "Nothing left on it" })
      update(i, { cn: note, cnErr: "", amount: String(Math.min(Number(rows[i]?.amount) || note.balance, note.balance)) })
    } catch (err) {
      update(i, { cn: null, cnErr: err?.response?.data?.message || "Not found" })
    }
  }

  // Card fields travel as their own keys, not folded into a note: the
  // transaction number is what a chargeback is traced by, and it should not
  // have to be parsed back out of a sentence. A credit-note row carries its
  // code so the till can redeem the right note.
  const proceed = () =>
    onProceed(
      rows.map((r) => ({
        mode: r.mode,
        amount: round2(r.amount),
        ...(r.mode === "card"
          ? { bankAccount: r.account, cardHolder: r.holder, transactionNo: r.txn }
          : {}),
        ...(r.mode === "credit_note" ? { code: String(r.code || "").trim().toUpperCase() } : {}),
      })),
    )

  // A loyalty row defaults its amount to the most the points can cover on this
  // bill, so the cashier rarely has to type it.
  const defaultLoyaltyAmount = () => round2(Math.min(loyaltyBalance * perPoint, loyaltyCap, due || payable))

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-white text-gray-800">
      <div className="flex items-center gap-3 bg-[#f1f3f5] px-3 py-1.5">
        <span className="p-1.5 text-gray-600"><PanelLeft size={18} /></span>
        <button type="button" onClick={onBack} className="rounded bg-[#2b2b2b] px-5 py-2.5 text-[15px] text-white hover:bg-black">Back to Sale</button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Sale summary */}
        <section className="flex w-1/3 min-w-[320px] flex-col border-r border-gray-300 bg-[#eaf6fb] px-3 py-3">
          <h2 className="text-[26px] font-medium">Sale Summary</h2>
          <p className="mt-2 text-[15px]">Customer : <span className="text-sky-500">{customer?.name || "Walk in Customer"}</span></p>

          <div className="mt-5 flex min-h-0 flex-1 flex-col overflow-auto rounded border border-gray-200 bg-white">
            <table className="w-full text-[15px]">
              <thead className="bg-gray-200 text-left">
                <tr><th className="w-10 px-2 py-2 font-medium">#</th><th className="px-2 py-2 font-medium">Product</th><th className="px-2 py-2 text-right font-medium">Qty</th></tr>
              </thead>
              <tbody>
                {(quote?.items || []).map((it, i) => (
                  <tr key={it.itemId || i} className="border-b border-gray-100">
                    <td className="px-2 py-1.5">{i + 1}</td><td className="px-2 py-1.5">{it.name}</td><td className="px-2 py-1.5 text-right">{Number(it.quantity).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="mt-3 text-[19px]">
            <div className="flex justify-between border-b border-gray-300 py-2"><dt>Tax Amount</dt><dd>{money(quote?.pricing?.tax)}</dd></div>
            <div className="flex justify-between border-b border-gray-300 py-2"><dt>Total Amounts</dt><dd>{money(round2(payable - (quote?.pricing?.roundOff || 0)))}</dd></div>
            <div className="flex justify-between border-b border-gray-300 py-2"><dt>Roundoff</dt><dd>{money(quote?.pricing?.roundOff)}</dd></div>
          </dl>
          <div className="mt-2 text-right">
            <div className="text-[40px] font-medium leading-none">{money(payable)}</div>
            <div className="text-[19px]">Payable Amount</div>
          </div>
        </section>

        {/* Pay */}
        <section className="flex min-w-0 flex-1 flex-col bg-[#eaf6fb] px-5 py-3">
          <div className="flex items-center gap-8">
            <span className="text-[26px] font-medium">Pay</span>
            <div className="flex h-11 items-center rounded border border-gray-300 bg-gray-100 text-gray-500">
              <span className="border-r border-gray-300 px-4">₹</span>
              <span className="w-56 px-3">{money(payable)}</span>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {rows.map((r, i) => (
              <div key={i} className="rounded bg-[#e8e8e8] px-5 py-4">
                <div className="grid grid-cols-[1fr_1.4fr_1.4fr_auto] items-end gap-8">
                  <div>
                    <span className={label}>Received Amount:</span>
                    <input className={field} value={r.amount} onChange={(e) => update(i, { amount: e.target.value })} inputMode="decimal" autoFocus={i === 0} />
                  </div>
                  <div>
                    <span className={label}>Payment Method:</span>
                    <select className={field} value={r.mode} onChange={(e) => update(i, { mode: e.target.value, ...(e.target.value === "loyalty" ? { amount: String(defaultLoyaltyAmount()) } : {}) })}>
                      {METHODS.map((m) => <option key={m.value} value={m.value} disabled={m.disabled}>{m.label}{m.disabled ? " (not set up)" : ""}</option>)}
                    </select>
                  </div>
                  {r.mode === "card" ? (
                    <div>
                      <span className={label}>Payment Account:</span>
                      <select className={field} value={r.account} onChange={(e) => update(i, { account: e.target.value })}>
                        <option value="">Select Bank Account</option>
                        {bankAccount ? <option value={bankAccount}>{bankAccount}</option> : null}
                      </select>
                    </div>
                  ) : r.mode === "credit_note" ? (
                    <div>
                      <span className={label}>Credit Note Code:</span>
                      <div className="flex gap-2">
                        <input
                          className={field}
                          value={r.code}
                          onChange={(e) => update(i, { code: e.target.value, cn: null, cnErr: "" })}
                          onBlur={(e) => checkCode(i, e.target.value)}
                          placeholder="CN-…"
                        />
                        <button type="button" onClick={() => checkCode(i, r.code)} className="h-11 shrink-0 rounded border border-sky-300 bg-white px-3 text-[14px] text-sky-600 hover:bg-sky-50">Check</button>
                      </div>
                      {r.cn ? (
                        <span className="mt-1 block text-[13px] text-emerald-600">Balance ₹{money(r.cn.balance)}{r.cn.customerName ? ` · ${r.cn.customerName}` : ""}</span>
                      ) : r.cnErr ? (
                        <span className="mt-1 block text-[13px] text-red-500">{r.cnErr}</span>
                      ) : null}
                    </div>
                  ) : r.mode === "loyalty" ? (
                    <div className="self-center">
                      <span className={label}>Points</span>
                      {!customer ? (
                        <span className="block text-[13px] text-red-500">Pick a customer to redeem points</span>
                      ) : (
                        <span className="block text-[14px] text-gray-700">
                          {loyaltyBalance} available (₹{money(round2(loyaltyBalance * perPoint))})
                          <span className="block text-[12px] text-gray-500">
                            Using {Math.round((Number(r.amount) || 0) / perPoint)} pts · min {minRedeem} · up to ₹{money(loyaltyCap)} of this bill
                          </span>
                        </span>
                      )}
                    </div>
                  ) : <div />}
                  <button type="button" onClick={() => remove(i)} disabled={rows.length === 1} className="flex h-11 w-11 items-center justify-center rounded border border-red-300 bg-white text-red-500 hover:bg-red-50 disabled:opacity-40" aria-label="Remove payment">
                    <X size={16} />
                  </button>
                </div>
                {r.mode === "card" ? (
                  <div className="mt-4 grid grid-cols-[1fr_2.9fr] gap-8">
                    <div>
                      <span className={label}>Card holder name:</span>
                      <input className={field} value={r.holder} onChange={(e) => update(i, { holder: e.target.value })} placeholder="Card holder name" />
                    </div>
                    <div className="pr-[52px]">
                      <span className={label}>Card Transaction No:</span>
                      <input className={field} value={r.txn} onChange={(e) => update(i, { txn: e.target.value })} placeholder="Card Transaction No." />
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="flex-1" />

          <button type="button" onClick={addRow} className="flex items-center gap-1 self-start text-[15px] font-semibold text-sky-500 hover:text-sky-600">
            <Plus size={14} className="rounded-sm bg-sky-500 text-white" /> Add More Payment
          </button>

          <div className="mt-6 min-h-[64px]">
            {change > 0 ? (
              <p className="text-[36px] font-medium">
                Give <span className="font-semibold">₹{money(change)}</span> Change
                {changeNeedsCash ? <span className="block text-[17px] text-red-500">Change can only be given out of cash received</span> : null}
              </p>
            ) : due > 0 ? (
              <p className="text-[34px] leading-tight text-red-500">
                Note : If you don't pay in full, the remaining amount will be considered as Pay Later.
                {!customer ? <span className="block text-[17px]">Pick a customer on the sale screen first — a due needs a name.</span> : null}
              </p>
            ) : null}
          </div>

          <button type="button" onClick={proceed} disabled={!canProceed} className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded bg-[#2b2b2b] text-[17px] text-white hover:bg-black disabled:opacity-40">
            {busy ? "Saving…" : "Proceed To Pay"} <ArrowRight size={18} />
          </button>
        </section>
      </div>
    </div>
  )
}
