import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Lock } from "lucide-react"
import { toast } from "sonner"
import { restaurantAPI } from "@food/api"
import { getMenuFromResponse, flattenMenuItems } from "@food/utils/menuItems"
import usePosCart from "@food/components/restaurant/pos/usePosCart"
import PosTopBar from "@food/components/restaurant/pos/PosTopBar"
import PosProductSearch from "@food/components/restaurant/pos/PosProductSearch"
import PosCustomerBox from "@food/components/restaurant/pos/PosCustomerBox"
import PosCartTable from "@food/components/restaurant/pos/PosCartTable"
import PosTotalsStrip from "@food/components/restaurant/pos/PosTotalsStrip"
import PosPayButtons from "@food/components/restaurant/pos/PosPayButtons"
import PosRightRail from "@food/components/restaurant/pos/PosRightRail"
import PosHoldBillsModal from "@food/components/restaurant/pos/PosHoldBillsModal"
import PosOrdersModal from "@food/components/restaurant/pos/PosOrdersModal"
import PosPayScreen from "@food/components/restaurant/pos/PosPayScreen"
import PosCouponModal from "@food/components/restaurant/pos/PosCouponModal"
import PosCardDetailsModal from "@food/components/restaurant/pos/PosCardDetailsModal"
import PosCashTenderModal from "@food/components/restaurant/pos/PosCashTenderModal"
import PosOrderBoard from "@food/components/restaurant/pos/PosOrderBoard"
import { PosChargesModal } from "@food/components/restaurant/pos/PosSmallModals"
import { KEY_ACTIONS, lineDiscount, printReceipt } from "@food/components/restaurant/pos/posUtils"
import PosOpenRegisterModal from "@food/components/restaurant/pos/PosOpenRegisterModal"
import PosCloseRegisterModal from "@food/components/restaurant/pos/PosCloseRegisterModal"
import PosCashControlModal from "@food/components/restaurant/pos/PosCashControlModal"
import PosCreditNoteModal from "@food/components/restaurant/pos/PosCreditNoteModal"
import { useNavigate } from "react-router-dom"
import { logoutRestaurantSession } from "@food/utils/restaurantLogout"

const extractRestaurant = (response) =>
  response?.data?.data?.restaurant || response?.data?.restaurant || response?.data?.data || null

const errMsg = (err, fallback) => err?.response?.data?.message || err?.message || fallback

/**
 * The seller's till.
 *
 * The screen keeps the cart and what the cashier typed; every figure that
 * ends up on the receipt comes from the server — the quote while the bill is
 * open, the saved order once it is paid — so the strip, the receipt and the
 * ledger can never disagree.
 */
export default function PointOfSale() {
  const navigate = useNavigate()
  const cart = usePosCart()
  const [menuItems, setMenuItems] = useState([])
  const [menuLoading, setMenuLoading] = useState(true)
  const [restaurant, setRestaurant] = useState(null)

  // POS register (shift): opened with a float on entry, closed with a drawer
  // count on exit/logout.
  const [shift, setShift] = useState(null)        // open shift, or null
  const [shiftLoaded, setShiftLoaded] = useState(false)
  const [closeSummary, setCloseSummary] = useState(null) // summary shown in the close modal
  const [cashCtrlSummary, setCashCtrlSummary] = useState(null) // summary shown in cash-control modal

  // Every till sale is a walk-in counter sale. The four-way selector is gone:
  // this is a grocery counter, not a restaurant floor — dine-in and take-away
  // are not distinctions it makes, and a delivery is placed in the app, where
  // the customer's address comes from. The server still takes the field and
  // still supports the other values; nothing here sends them any more.
  const orderType = "walk_in"
  const [salesmanChoice, setSalesman] = useState("")
  const [autoPrint, setAutoPrint] = useState(() => {
    try { return localStorage.getItem("pos.autoPrint") === "1" } catch { return false }
  })

  const [customer, setCustomer] = useState(null)
  const [summary, setSummary] = useState(null)
  const [remarks, setRemarks] = useState("")
  const [flat, setFlat] = useState({ type: "percent", value: 0 })
  const [additionalCharges, setAdditionalCharges] = useState(0)
  const [roundOff, setRoundOff] = useState(false)
  const [couponCode, setCouponCode] = useState("")
  const [earnLoyalty, setEarnLoyalty] = useState(true) // award points on this bill

  const [quote, setQuote] = useState(null)
  const [quoting, setQuoting] = useState(false)
  const [lastBill, setLastBill] = useState(null)
  const [busy, setBusy] = useState(false)
  const [modal, setModal] = useState(null) // holds | orders | payments | multiple | coupon | charges | card | cash
  // Whether the payment being collected came from a "& Print" key (F8, F9)
  // rather than its plain twin — the dialog is the same either way.
  const [pendingWillPrint, setPendingWillPrint] = useState(false)
  const [invoiceRef, setInvoiceRef] = useState("")
  // Which status the order board is showing. Null while the till is on the
  // sale screen, so no pill sits lit over a screen that is not a status.
  const [orderStatus, setOrderStatus] = useState(null)

  // The shop's own account, named on a card tender so a settlement query knows
  // which bank the money landed in.
  const bankAccounts = useMemo(() => {
    if (!restaurant?.accountNumber) return []
    const holder = restaurant.accountHolderName || restaurant.restaurantName || "Account"
    const tail = String(restaurant.accountNumber).slice(-4)
    return [`${holder} · ••••${tail}${restaurant.ifscCode ? ` · ${restaurant.ifscCode}` : ""}`]
  }, [restaurant])

  const salesmen = useMemo(() => {
    const names = [restaurant?.ownerName, restaurant?.restaurantName].map((s) => String(s || "").trim()).filter(Boolean)
    return names.length ? [...new Set(names)] : ["Counter"]
  }, [restaurant])
  // Until the cashier picks one, the owner is the salesman — derived, not
  // synced, so there is no render with an empty select.
  const salesman = salesmanChoice || salesmen[0]

  // ── loading ──────────────────────────────────────────────────────────

  const loadMenu = useCallback(async () => {
    setMenuLoading(true)
    try {
      const res = await restaurantAPI.getMenu()
      setMenuItems(flattenMenuItems(getMenuFromResponse(res)))
    } catch (err) {
      toast.error(errMsg(err, "Could not load products"))
    } finally {
      setMenuLoading(false)
    }
  }, [])

  const loadLastBill = useCallback(async () => {
    try {
      const res = await restaurantAPI.posLastBill()
      setLastBill(res?.data?.data || null)
    } catch {
      setLastBill(null)
    }
  }, [])

  useEffect(() => {
    loadMenu()
    loadLastBill()
    restaurantAPI.getCurrentRestaurant().then((res) => setRestaurant(extractRestaurant(res))).catch(() => {})
    // Is a register already open? If not, we prompt to open one.
    restaurantAPI.posCurrentShift()
      .then((res) => setShift(res?.data?.data?.shift || null))
      .catch(() => {})
      .finally(() => setShiftLoaded(true))
  }, [loadMenu, loadLastBill])

  // Load the live shift summary into the cash-control modal when it opens.
  useEffect(() => {
    if (modal !== "cashControl") return
    restaurantAPI.posShiftSummary()
      .then((res) => setCashCtrlSummary(res?.data?.data?.shift || null))
      .catch(() => setCashCtrlSummary(shift))
  }, [modal, shift])

  const handleOpenRegister = async (openingCash) => {
    try {
      const res = await restaurantAPI.posOpenShift({ openingCash, cashierName: salesman })
      setShift(res?.data?.data?.shift || null)
      toast.success("Register opened")
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not open the register")
    }
  }

  // Leaving the POS (back / exit) closes the register first: fetch the live
  // summary and show the count screen.
  const requestExit = async () => {
    if (!shift) { navigate("/seller/dashboard"); return }
    try {
      const res = await restaurantAPI.posShiftSummary()
      const open = res?.data?.data?.shift
      // The register may have been closed elsewhere since this screen loaded;
      // with nothing to count, don't trap the cashier behind a dead modal —
      // just leave.
      if (!open) { setShift(null); navigate("/seller/dashboard"); return }
      setCloseSummary(open)
    } catch {
      setCloseSummary(shift)
    }
  }

  const handleCloseRegister = async (payload) => {
    try {
      await restaurantAPI.posCloseShift(payload)
      toast.success("Register closed")
      setCloseSummary(null)
      setShift(null)
      await logoutRestaurantSession({ navigate })
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not close the register")
    }
  }

  useEffect(() => {
    try { localStorage.setItem("pos.autoPrint", autoPrint ? "1" : "0") } catch { /* private mode */ }
  }, [autoPrint])

  // The customer panel: their history with this shop, refreshed after each sale.
  const loadSummary = useCallback(async (id) => {
    if (!id) { setSummary(null); return }
    try {
      const res = await restaurantAPI.posCustomerSummary(id)
      setSummary(res?.data?.data || null)
    } catch {
      setSummary(null)
    }
  }, [])

  useEffect(() => { loadSummary(customer?.id) }, [customer?.id, loadSummary])

  // The selected customer's loyalty balance and the live earn/redeem rules,
  // used by the Pay screen to redeem points and by the right rail to show them.
  const [loyalty, setLoyalty] = useState(null)
  const loadLoyalty = useCallback(async (id) => {
    if (!id) { setLoyalty(null); return }
    try {
      const res = await restaurantAPI.posLoyaltyAccount(id)
      setLoyalty(res?.data?.data || null)
    } catch {
      setLoyalty(null)
    }
  }, [])
  useEffect(() => { loadLoyalty(customer?.id) }, [customer?.id, loadLoyalty])

  // ── the quote ────────────────────────────────────────────────────────

  const billInput = useCallback(() => ({
    orderType,
    salesman,
    remarks,
    customerId: customer?.id || undefined,
    customerName: customer?.name || undefined,
    customerPhone: customer?.phone || undefined,
    // itemCode and mrp ride along for the sake of a hold: every figure that
    // decides the bill is re-read from the catalogue, but these two are only
    // ever read in the product search, and a parked bill has to come back
    // looking like the one that was parked.
    items: cart.lines.map((l) => ({
      itemId: l.itemId,
      quantity: Number(l.quantity) || 1,
      discount: lineDiscount(l),
      itemCode: l.itemCode || undefined,
      mrp: l.mrp != null ? l.mrp : undefined,
    })),
    flatDiscount: flat,
    additionalCharges,
    roundOff,
    couponCode: couponCode || undefined,
    earnLoyalty,
  }), [orderType, salesman, remarks, customer, cart.lines, flat, additionalCharges, roundOff, couponCode, earnLoyalty])

  // Just the lines, memoised: the coupon list refetches when the cart changes,
  // and a fresh array every render would make that an endless loop.
  const couponItems = useMemo(
    () => cart.lines.map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity) || 1 })),
    [cart.lines],
  )

  const quoteTimer = useRef(null)
  useEffect(() => {
    clearTimeout(quoteTimer.current)
    if (cart.lines.length === 0) { setQuote(null); setQuoting(false); return undefined }
    setQuoting(true)
    quoteTimer.current = setTimeout(async () => {
      try {
        const res = await restaurantAPI.posQuote(billInput())
        setQuote(res?.data?.data || null)
      } catch (err) {
        setQuote(null)
        toast.error(errMsg(err, "Could not price the bill"), { id: "pos-quote" })
      } finally {
        setQuoting(false)
      }
    }, 300)
    return () => clearTimeout(quoteTimer.current)
  }, [billInput, cart.lines.length])

  // ── actions ──────────────────────────────────────────────────────────

  const resetBill = useCallback(() => {
    cart.clear()
    setRemarks("")
    setFlat({ type: "percent", value: 0 })
    setAdditionalCharges(0)
    setRoundOff(false)
    setCouponCode("")
    setCustomer(null)
    setQuote(null)
    setEarnLoyalty(true)
  }, [cart])

  const addItem = useCallback((item) => {
    if (item.stockQty != null && Number(item.stockQty) <= 0) {
      toast.error(`${item.name} is out of stock`)
      return
    }
    cart.addItem(item)
  }, [cart])

  const pay = useCallback(async (mode, { print = false, tenders } = {}) => {
    if (!cart.lines.length || busy) return
    if (mode === "pay_later" && !customer) {
      toast.error("Pay later needs a customer — pick one or add a phone number")
      return
    }
    if (mode === "multiple" && !tenders) { setModal("multiple"); return }
    // A card swipe is recorded, not just taken: the machine's transaction
    // number is what a chargeback is traced by, and nobody goes back for it.
    if (mode === "card" && !tenders) { setPendingWillPrint(print); setModal("card"); return }
    // Cash is handed over as notes, so the amount has to be asked for before
    // the sale — the change owed is worked out from it, not from the bill.
    if (mode === "cash" && !tenders) { setPendingWillPrint(print); setModal("cash"); return }

    setBusy(true)
    try {
      const res = await restaurantAPI.posCreateOrder({ ...billInput(), paymentMode: mode, tenders })
      const receipt = res?.data?.data?.receipt
      toast.success(`Bill ${receipt?.billNo || ""} saved · ₹${receipt?.pricing?.total ?? ""}`)
      setLastBill(receipt || null)
      if ((print || autoPrint) && receipt) printReceipt(receipt)
      const customerId = customer?.id
      resetBill()
      setModal(null)
      if (customerId) { loadSummary(customerId); loadLoyalty(customerId) }
    } catch (err) {
      toast.error(errMsg(err, "The sale could not be saved"))
    } finally {
      setBusy(false)
    }
  }, [cart.lines.length, busy, customer, billInput, autoPrint, resetBill, loadSummary, loadLoyalty])

  const hold = useCallback(async (print) => {
    if (!cart.lines.length || busy) return
    setBusy(true)
    try {
      // The slip comes back from the server rather than being assembled here:
      // it is priced by the same engine the sale will use, so the paper in the
      // customer's hand and the totals strip they just watched agree.
      const res = await restaurantAPI.posHold(billInput())
      const { held, receipt } = res?.data?.data || {}
      if (print && receipt) printReceipt(receipt, { title: "Hold Bill", held: true })
      toast.success(held?.holdNo ? `Bill held as ${held.holdNo}` : "Bill held")
      resetBill()
    } catch (err) {
      toast.error(errMsg(err, "Could not hold the bill"))
    } finally {
      setBusy(false)
    }
  }, [cart.lines.length, busy, billInput, resetBill])

  const resumeHeld = useCallback((held) => {
    if (!held) return
    resetBill()
    cart.load(held.items || [])
    setRemarks(held.remarks || "")
    setFlat(held.flatDiscount?.value ? { type: held.flatDiscount.type || "percent", value: held.flatDiscount.value } : { type: "percent", value: 0 })
    setAdditionalCharges(Number(held.additionalCharges) || 0)
    setRoundOff(Boolean(held.roundOff))
    setCouponCode(held.couponCode || "")
    if (held.customer?.userId || held.customer?.phone) {
      setCustomer({ id: held.customer.userId || null, name: held.customer.name || "", phone: held.customer.phone || "" })
    }
    setModal(null)
  }, [cart, resetBill])

  const printLast = useCallback(() => {
    if (!lastBill) { toast.error("No bill to print yet"); return }
    if (!printReceipt(lastBill)) toast.error("The browser blocked the print window — allow pop-ups for this site")
  }, [lastBill])

  const scanInvoice = useCallback(async (ref) => {
    const key = String(ref || "").trim()
    if (!key) return
    try {
      const res = await restaurantAPI.posGetBill(key)
      const receipt = res?.data?.data
      if (receipt) { setLastBill(receipt); printReceipt(receipt) }
      setInvoiceRef("")
    } catch (err) {
      toast.error(errMsg(err, "No bill with that number"))
    }
  }, [])

  // The F-keys printed on the buttons. Off while a dialog is open so Enter/F-keys
  // inside it do not fire a sale behind it.
  useEffect(() => {
    const onKey = (e) => {
      const action = KEY_ACTIONS[e.key]
      if (!action || modal) return
      e.preventDefault()
      if (action.hold) hold(Boolean(action.print))
      else pay(action.mode, { print: Boolean(action.print) })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [modal, hold, pay])

  const couponApplied = Boolean(couponCode) && Boolean(quote?.pricing?.appliedCoupon)
  const disabled = cart.lines.length === 0 || busy

  // Admin can switch POS off for this store — the backend already blocks
  // quote/create, so show a clear notice instead of a broken screen.
  if (restaurant && restaurant.posEnabled === false) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-[#f4f7fb] p-6 text-center text-gray-700">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-200">
          <Lock className="h-8 w-8 text-slate-500" />
        </div>
        <h2 className="mt-4 text-xl font-bold text-slate-900">Point of Sale is disabled</h2>
        <p className="mt-1 max-w-sm text-sm text-slate-500">
          POS has been turned off for your store by the admin. Please contact the
          admin if you need counter billing enabled.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-[#f4f7fb] text-gray-800">
      <PosTopBar
        orderStatus={orderStatus}
        onOrderStatus={setOrderStatus}
        salesman={salesman}
        salesmen={salesmen}
        onSalesman={setSalesman}
        autoPrint={autoPrint}
        onAutoPrint={setAutoPrint}
        onPrintLast={printLast}
        onSync={loadMenu}
        syncing={menuLoading}
        onClearBill={resetBill}
        hasLines={cart.lines.length > 0}
        onExit={requestExit}
      />

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col gap-2 p-2">
          <div className="flex items-stretch gap-3">
            <PosProductSearch items={menuItems} onAdd={addItem} />
            <PosCustomerBox customer={customer} onChange={setCustomer} />
            <input
              value={invoiceRef}
              onChange={(e) => setInvoiceRef(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && scanInvoice(invoiceRef)}
              placeholder="Scan Sales Invoice"
              className="h-10 w-[27%] min-w-[220px] rounded border border-gray-300 bg-white px-3 text-[15px] outline-none placeholder:text-gray-400 focus:border-sky-400"
            />
          </div>

          {couponCode ? (
            <div className="flex flex-wrap items-center gap-2">
              {/* A coupon can stop applying after it was picked — the cashier
                  removes a line and the bill drops below its minimum. The strip
                  would just show no discount, so say which it is. */}
              {couponCode ? (
                <button
                  type="button"
                  onClick={() => setModal("coupon")}
                  className={`rounded px-2 py-0.5 text-xs ${couponApplied ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}
                >
                  {couponApplied
                    ? `${couponCode} · −₹${quote?.pricing?.discount ?? 0}`
                    : `${couponCode} no longer applies · change`}
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="flex min-h-0 flex-1 flex-col rounded border border-gray-200 bg-white">
            <PosCartTable lines={cart.lines} onUpdate={cart.updateLine} onRemove={cart.removeLine} />
          </div>

          <input
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            placeholder="Remarks"
            // Blue-bordered rather than grey: it is the one free-text field on
            // a screen of figures, and the cashier has to be able to find it
            // without hunting.
            className="h-10 w-full rounded border-2 border-sky-400 bg-white px-3 text-[15px] outline-none placeholder:text-gray-500 focus:border-sky-500"
          />

          <PosTotalsStrip
            totals={cart.totals}
            quote={quote}
            quoting={quoting}
            flat={flat}
            onFlat={setFlat}
            additionalCharges={additionalCharges}
            onAdditionalCharges={() => setModal("charges")}
            roundOff={roundOff}
            onRoundOff={setRoundOff}
            earnLoyalty={earnLoyalty}
            onEarnLoyalty={setEarnLoyalty}
          />

          <PosPayButtons disabled={disabled} onPay={pay} onHold={hold} onCoupon={() => setModal("coupon")} hasCustomer={Boolean(customer)} />
        </main>

        <PosRightRail
          onOpen={setModal}
          summary={summary}
          customer={customer}
          lastBill={lastBill}
          onPrintLast={printLast}
          onRedeemLoyalty={() => {
            if (!cart.lines.length) { toast.error("Add items to the bill first"); return }
            if (!customer) { toast.error("Pick a customer to redeem their points"); return }
            if (!(loyalty?.balance > 0)) { toast.error("This customer has no points to redeem"); return }
            setModal("multiple")
          }}
        />
      </div>

      {orderStatus ? (
        <PosOrderBoard status={orderStatus} onStatus={setOrderStatus} onClose={() => setOrderStatus(null)} />
      ) : null}
      {modal === "holds" ? <PosHoldBillsModal onClose={() => setModal(null)} onResume={resumeHeld} /> : null}
      {modal === "orders" || modal === "payments" ? (
        <PosOrdersModal mode={modal} onClose={() => setModal(null)} onPaid={() => { loadLastBill(); if (customer?.id) loadSummary(customer.id) }} />
      ) : null}
      {modal === "multiple" && quote?.pricing ? (
        <PosPayScreen
          quote={quote}
          customer={customer}
          bankAccount={restaurant?.accountNumber ? `${restaurant.accountHolderName || restaurant.restaurantName || "Account"} · ${String(restaurant.accountNumber).slice(-4).padStart(8, "•")}${restaurant.ifscCode ? ` · ${restaurant.ifscCode}` : ""}` : ""}
          busy={busy}
          onBack={() => setModal(null)}
          // The Pay screen always prints: it is the deliberate path a cashier
          // walks for a split or a cash-with-change sale, and the change due is
          // on the bill. The auto-print toggle governs the quick F-keys, which
          // is what the separate Cash / Cash & Print pair is for.
          onProceed={(tenders) => pay("multiple", { tenders, print: true })}
          onLookupCreditNote={async (code) => {
            const res = await restaurantAPI.posLookupCreditNote(code)
            return res?.data?.data?.creditNote || res?.data?.creditNote || null
          }}
          loyaltyBalance={loyalty?.balance || 0}
          loyaltyConfig={loyalty?.config}
        />
      ) : null}
      {modal === "coupon" ? (
        <PosCouponModal
          current={couponCode}
          invoiceBalance={quote?.pricing?.total ?? 0}
          items={couponItems}
          customerId={customer?.id}
          onClose={() => setModal(null)}
          onApply={(code) => { setCouponCode(code); setModal(null) }}
        />
      ) : null}
      {modal === "charges" ? (
        <PosChargesModal current={additionalCharges} onClose={() => setModal(null)} onApply={(n) => { setAdditionalCharges(n); setModal(null) }} />
      ) : null}
      {modal === "card" && quote?.pricing ? (
        <PosCardDetailsModal
          total={quote.pricing.total}
          bankAccounts={bankAccounts}
          hasCustomer={Boolean(customer)}
          busy={busy}
          onClose={() => setModal(null)}
          onFinalize={(card) =>
            pay("card", { print: pendingWillPrint || autoPrint, tenders: [{ mode: "card", ...card }] })
          }
        />
      ) : null}
      {modal === "cash" && quote?.pricing ? (
        <PosCashTenderModal
          due={quote.pricing.total}
          hasCustomer={Boolean(customer)}
          busy={busy}
          onCancel={() => setModal(null)}
          onSubmit={(amount) =>
            pay("cash", { print: pendingWillPrint || autoPrint, tenders: [{ mode: "cash", amount }] })
          }
        />
      ) : null}

      {/* Open the register on entry when none is running. */}
      {shiftLoaded && !shift ? (
        <PosOpenRegisterModal cashierName={salesman} onOpen={handleOpenRegister} onExit={() => navigate("/seller/dashboard")} />
      ) : null}

      {/* Close the register (count the drawer) on exit / logout. */}
      {closeSummary ? (
        <PosCloseRegisterModal
          summary={closeSummary}
          onClose={() => setCloseSummary(null)}
          onConfirm={handleCloseRegister}
        />
      ) : null}

      {/* Cash control — pay cash in / out of the drawer during the shift. */}
      {modal === "cashControl" ? (
        <PosCashControlModal
          summary={cashCtrlSummary}
          onClose={() => setModal(null)}
          onUpdated={(s) => { if (s) setShift((prev) => ({ ...prev, cashReceived: s.cashReceived, cashOut: s.cashOut })) }}
        />
      ) : null}

      {/* Credit notes — issue a return as a redeemable balance, or review notes. */}
      {modal === "creditNotes" ? (
        <PosCreditNoteModal onClose={() => setModal(null)} />
      ) : null}
    </div>
  )
}
