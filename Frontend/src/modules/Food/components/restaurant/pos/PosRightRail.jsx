import { Columns3, UtensilsCrossed, Receipt, Gift, Banknote, FileText, List, HandCoins, Printer } from "lucide-react"
import { fmtDateTime, money, TENDER_LABEL } from "./posUtils"

const tile = "flex flex-col items-center justify-center gap-1 rounded px-1 py-2 text-[15px] text-gray-800 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
const NOT_YET = "Not set up in this system yet"

/**
 * The right-hand column: the action tiles, the customer's history with this
 * shop, and the last bill.
 *
 * Tiles with nothing behind them (tables, loyalty, credit notes, cash
 * control) are drawn as in the reference but disabled, with the reason on
 * hover — a button that opens an empty screen is worse than one that says why.
 */
export default function PosRightRail({ onOpen, summary, customer, lastBill, onPrintLast, onRedeemLoyalty }) {
  const row = (k, v) => (
    <div className="flex items-start justify-between gap-2 py-1">
      <span className="text-[15px] font-semibold text-gray-800">{k}:</span>
      <span className="text-[15px] text-gray-800">{v ?? "-"}</span>
    </div>
  )

  return (
    <aside className="flex w-[310px] shrink-0 flex-col gap-2 p-2">
      <div className="grid grid-cols-3 gap-1 rounded border border-gray-200 bg-white p-1">
        <button type="button" className={tile} onClick={() => onOpen("holds")}><Columns3 size={26} className="text-sky-600" />Hold Bill</button>
        <button type="button" className={tile} disabled title={NOT_YET}><UtensilsCrossed size={26} className="text-sky-600" />Tables</button>
        <button type="button" className={tile} onClick={() => onOpen("payments")}><Receipt size={26} className="text-sky-600" />Payments</button>
        <button type="button" className={tile} onClick={onRedeemLoyalty} title="Redeem the customer's points on this bill"><Gift size={26} className="text-sky-600" />Reedem<br />Loyalty</button>
        <button type="button" className={tile} onClick={() => onOpen("payments")}><Banknote size={26} className="text-sky-600" />Add Payment</button>
        <button type="button" className={tile} onClick={() => onOpen("creditNotes")} title="Issue or review credit notes"><FileText size={26} className="text-sky-600" />Credit Notes</button>
        <button type="button" className={tile} onClick={() => onOpen("orders")}><List size={26} className="text-sky-600" />Orders</button>
        <button type="button" className={tile} onClick={() => onOpen("cashControl")} title="Pay cash in or out of the drawer"><HandCoins size={26} className="text-sky-600" />Cash Control</button>
      </div>

      <div className="rounded border border-gray-200 bg-white px-3 py-2">
        <h3 className="mb-1 text-[19px] font-semibold text-gray-800">Customer Details</h3>
        {row("Last Visited", summary ? fmtDateTime(summary.lastVisitedAt) : null)}
        {row("Last Bill Amount", summary && summary.lastBillAmount != null ? `₹${money(summary.lastBillAmount)}` : null)}
        {row("Most Purchased Item", summary?.mostPurchasedItem || null)}
        {row("Payment Mode", summary?.lastPaymentMode ? TENDER_LABEL[summary.lastPaymentMode] || summary.lastPaymentMode : null)}
        {row("Due Payment", summary ? `₹${money(summary.duePayment)}` : null)}
        {row("Total Purchase", summary ? summary.totalPurchases : customer ? null : 0)}
        {row("Loyalty Points", summary?.loyaltyPoints != null ? summary.loyaltyPoints : null)}
      </div>

      <div className="rounded border border-gray-200 bg-white px-3 py-2">
        {row("Last Bill No.", lastBill?.billNo || null)}
        {row("Last Bill Amount", lastBill ? `₹${money(lastBill.pricing?.total)}` : null)}
        <button
          type="button"
          onClick={onPrintLast}
          disabled={!lastBill}
          className="mt-1 flex h-9 w-full items-center justify-center gap-2 rounded bg-sky-400 text-[15px] font-medium text-white hover:bg-sky-500 disabled:opacity-40"
        >
          <Printer size={16} /> Last Bill Print
        </button>
      </div>
    </aside>
  )
}
