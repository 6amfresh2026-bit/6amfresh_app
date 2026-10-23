import { Layers, Wallet, PauseCircle, ChevronsRight, CreditCard, IndianRupee, Gift, CalendarClock } from "lucide-react"

// A disabled key keeps the row's weight rather than dropping to a ghost: this
// is a wall of twelve identical buttons and one washed-out gap reads as a
// rendering fault. Dimmed enough to look inactive, solid enough to belong.
const btn = "flex h-12 items-center justify-center gap-2 rounded bg-[#1f1f1f] text-[15px] font-medium text-white hover:bg-black disabled:cursor-not-allowed disabled:bg-[#4a4a4a] disabled:text-neutral-300 disabled:hover:bg-[#4a4a4a]"

/**
 * The twelve buttons, in the reference's grid, each with its F-key. The same
 * F-keys are bound on the page so the cashier never needs the mouse.
 */
export default function PosPayButtons({ disabled, onPay, onHold, onCoupon, hasCustomer, can = () => true }) {
  const off = disabled
  const noHold = off || !can("hold_bills")
  const noCoupon = off || !can("coupons")
  const noCredit = off || !can("pay_later")
  const lockedTitle = "Your POS account is not allowed to do this"
  return (
    <div className="grid grid-cols-6 gap-2 px-2 py-2">
      <button type="button" className={btn} disabled={off} onClick={() => onPay("multiple")}><Layers size={16} /> Multiple Pay(F12)</button>
      <button type="button" className={btn} disabled title="Store credit is not set up in this system yet"><Wallet size={16} /> Redeem Credit</button>
      <button type="button" className={btn} disabled={noHold} title={can("hold_bills") ? "" : lockedTitle} onClick={() => onHold(false)}><PauseCircle size={16} /> Hold (F6)</button>
      <button type="button" className={btn} disabled={off} onClick={() => onPay("upi")}><ChevronsRight size={16} /> UPI (F5)</button>
      <button type="button" className={btn} disabled={off} onClick={() => onPay("card")}><CreditCard size={16} /> Card (F3)</button>
      <button type="button" className={btn} disabled={off} onClick={() => onPay("cash")}><IndianRupee size={16} /> Cash (F4)</button>

      <button type="button" className={btn} disabled={noCoupon} title={can("coupons") ? "" : lockedTitle} onClick={onCoupon}><Gift size={16} /> Apply Coupon</button>
      <button type="button" className={btn} disabled={noCredit} onClick={() => onPay("pay_later")} title={!can("pay_later") ? lockedTitle : hasCustomer ? "" : "Pick a customer first — a due needs a name"}><CalendarClock size={16} /> Pay Later (F11)</button>
      <button type="button" className={btn} disabled={noHold} title={can("hold_bills") ? "" : lockedTitle} onClick={() => onHold(true)}><PauseCircle size={16} /> Hold &amp; Print(F7)</button>
      <button type="button" className={btn} disabled={off} onClick={() => onPay("upi", { print: true })}><ChevronsRight size={16} /> UPI &amp; Print (F10)</button>
      <button type="button" className={btn} disabled={off} onClick={() => onPay("card", { print: true })}><CreditCard size={16} /> Card &amp; Print (F9)</button>
      <button type="button" className={btn} disabled={off} onClick={() => onPay("cash", { print: true })}><IndianRupee size={16} /> Cash &amp; Print (F8)</button>
    </div>
  )
}
