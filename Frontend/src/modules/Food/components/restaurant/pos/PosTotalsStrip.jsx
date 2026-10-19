import { Info, Percent, IndianRupee } from "lucide-react"
import { money } from "./posUtils"

const cell = "flex flex-col items-center justify-center border-r border-gray-200 px-3 py-2 last:border-r-0"
const label = "mt-1 text-[15px] text-gray-600"
const value = "text-[22px] leading-tight text-gray-700"

/**
 * The figures under the bill. Quantity and MRP are counted locally; tax,
 * discount and the amount come from the server's quote, because that is
 * what the sale will be charged — the strip must never show a number the
 * receipt then contradicts.
 */
export default function PosTotalsStrip({
  totals,
  quote,
  quoting,
  flat,
  onFlat,
  additionalCharges,
  onAdditionalCharges,
  roundOff,
  onRoundOff,
  earnLoyalty,
  onEarnLoyalty,
}) {
  const p = quote?.pricing
  const amount = p ? p.total : Math.max(0, totals.gross - totals.lineDiscount)
  const discount = p ? p.discount : totals.lineDiscount

  return (
    // Nine cells, nine columns. It was eight, so Amount — the one figure the
    // cashier and the customer both look at — was pushed into a fraction of a
    // column and the col-start-9 meant to rescue it referred to a column that
    // did not exist.
    <div className="grid grid-cols-9 items-stretch border-y border-gray-200 bg-white">
      <div className={cell}>
        <label className="relative inline-block h-6 w-12 cursor-pointer" title="Award loyalty points to a named customer on this bill">
          <input type="checkbox" className="peer sr-only" checked={Boolean(earnLoyalty)} onChange={(e) => onEarnLoyalty?.(e.target.checked)} />
          <span className="absolute inset-0 rounded-full bg-gray-300 transition-colors peer-checked:bg-sky-500" />
          <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-6" />
        </label>
        <span className={label}>Earn Loyalty</span>
      </div>

      <div className={cell}>
        <span className={value}>{totals.quantity.toFixed(3)}</span>
        <span className={label}>Quantity</span>
      </div>

      <div className={cell}>
        <span className={value}>{money(totals.mrp)}</span>
        <span className={label}>MRP</span>
      </div>

      <div className={cell}>
        <span className={value}>{quoting && !p ? "…" : money(p?.tax ?? 0)}</span>
        <span className={label}>Tax Amount</span>
      </div>

      <div className={cell}>
        <span className={value}>{money(additionalCharges)}</span>
        <button
          type="button"
          onClick={onAdditionalCharges}
          className="mt-1 rounded bg-[#1f1f1f] px-2 py-0.5 text-[13px] font-semibold text-white"
        >
          Add.Charges +
        </button>
      </div>

      <div className={cell}>
        <span className={value}>{money(discount)}</span>
        <span
          className="text-sky-500"
          title={p ? `Coupon ₹${money(p.discount - (p.manualDiscount || 0), 2)} · Manual ₹${money(p.manualDiscount || 0, 2)}` : "Line and flat discounts"}
        >
          <Info size={14} />
        </span>
        <span className={label}>Discount</span>
      </div>

      <div className={cell}>
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => onFlat({ ...flat, type: flat.type === "percent" ? "flat" : "percent" })}
            className="flex h-9 w-9 items-center justify-center rounded-l bg-[#1f1f1f] text-white"
            title={flat.type === "percent" ? "Percentage — click for rupees" : "Rupees — click for percentage"}
          >
            {flat.type === "percent" ? <Percent size={14} /> : <IndianRupee size={14} />}
          </button>
          <input
            value={flat.value}
            onChange={(e) => onFlat({ ...flat, value: Math.max(0, Number(e.target.value) || 0) })}
            inputMode="decimal"
            className="h-9 w-20 rounded-r border border-l-0 border-gray-300 px-2 text-right text-[17px] outline-none focus:border-sky-400"
          />
        </div>
        <span className={label}>Flat Discount</span>
      </div>

      <div className={`${cell} border-r`}>
        <button
          type="button"
          onClick={() => onRoundOff(!roundOff)}
          className={`h-9 w-28 rounded border px-2 text-right text-[17px] ${roundOff ? "border-sky-400 bg-sky-50 text-gray-800" : "border-gray-300 text-gray-500"}`}
          title={roundOff ? "Rounding to the nearest rupee — click to switch off" : "Click to round the bill to the nearest rupee"}
        >
          {money(p?.roundOff ?? 0)}
        </button>
        <span className={label}>Round OFF</span>
      </div>

      <div className={cell}>
        <span className="text-[34px] font-semibold leading-none text-sky-500">{quoting && !p ? "…" : money(amount, 0)}</span>
        <span className={label}>Amount</span>
      </div>
    </div>
  )
}
