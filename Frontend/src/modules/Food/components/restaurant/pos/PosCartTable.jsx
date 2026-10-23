import { Minus, Plus, Trash2 } from "lucide-react"
import { isWeighedItem } from "./scaleParser"
import { lineDiscount, lineNet, money } from "./posUtils"

const th = "px-3 py-2.5 text-left text-[15px] font-semibold text-gray-700"
const td = "px-3 py-1.5 text-sm text-gray-800 align-middle"
const numInput = "h-8 w-20 rounded border border-gray-300 px-2 text-right text-sm outline-none focus:border-sky-400"

/** The bill's lines, in the reference's column order. */
export default function PosCartTable({ lines, onUpdate, onRemove }) {
  const setQty = (line, qty) => {
    // A weighed line is a weight (1.250 kg); everything else is a whole count.
    const weighed = isWeighedItem(line)
    const q = weighed ? Math.max(0.001, Math.round((Number(qty) || 0) * 1000) / 1000) : Math.max(1, Math.floor(Number(qty) || 1))
    if (line.stockQty != null && q > Number(line.stockQty)) {
      onUpdate(line.key, { quantity: Math.max(weighed ? 0.001 : 1, Number(line.stockQty)) })
      return
    }
    onUpdate(line.key, { quantity: q })
  }

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-[#e5e7eb]">
          <tr>
            <th className={`${th} w-10`}>#</th>
            <th className={`${th} w-32`}>Itemcode</th>
            <th className={th}>Product</th>
            <th className={`${th} w-36 text-center`}>Qty</th>
            <th className={`${th} w-20 text-right`}>MRP</th>
            <th className={`${th} w-20`}>Unit</th>
            <th className={`${th} w-24 text-right`}>Discount</th>
            <th className={`${th} w-24 text-right`}>Add Disc</th>
            <th className={`${th} w-24 text-right`}>Unit Cost</th>
            <th className={`${th} w-28 text-right`}>Net Amount</th>
            <th className={`${th} w-10`} />
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td colSpan={11} className="py-24 text-center text-sm text-gray-400">Scan a barcode or type a product name to start a bill</td>
            </tr>
          ) : (
            lines.map((line, i) => (
              <tr key={line.key} className="border-b border-gray-100 hover:bg-sky-50/40">
                <td className={td}>{i + 1}</td>
                <td className={`${td} text-gray-500`}>{line.itemCode || "-"}</td>
                <td className={`${td} font-medium`}>
                  {line.name}
                  {line.stockQty != null && Number(line.stockQty) <= Number(line.quantity) ? (
                    <span className="ml-2 text-xs text-amber-600">{Number(line.stockQty)} in stock</span>
                  ) : null}
                </td>
                <td className={`${td}`}>
                  <div className="flex items-center justify-center gap-1">
                    <button type="button" className="rounded border border-gray-300 p-1 hover:bg-gray-100" onClick={() => setQty(line, Number(line.quantity) - (isWeighedItem(line) ? 0.1 : 1))} aria-label="Less"><Minus size={12} /></button>
                    <input className="h-8 w-14 rounded border border-gray-300 text-center text-sm outline-none focus:border-sky-400" value={line.quantity} onChange={(e) => setQty(line, e.target.value)} inputMode={isWeighedItem(line) ? "decimal" : "numeric"} />
                    <button type="button" className="rounded border border-gray-300 p-1 hover:bg-gray-100" onClick={() => setQty(line, Number(line.quantity) + (isWeighedItem(line) ? 0.1 : 1))} aria-label="More"><Plus size={12} /></button>
                  </div>
                </td>
                <td className={`${td} text-right`}>{line.mrp != null ? money(line.mrp, 2) : money(line.price, 2)}</td>
                <td className={`${td} text-gray-500`}>{line.unit || "-"}</td>
                <td className={`${td} text-right`}>
                  <span className="inline-flex items-center gap-1">
                    <input className={numInput} value={line.discountPct} onChange={(e) => onUpdate(line.key, { discountPct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} inputMode="decimal" />
                    <span className="text-xs text-gray-500">%</span>
                  </span>
                </td>
                <td className={`${td} text-right`}>
                  <input className={numInput} value={line.addDisc} onChange={(e) => onUpdate(line.key, { addDisc: Math.max(0, Number(e.target.value) || 0) })} inputMode="decimal" title={`Line discount ₹${money(lineDiscount(line), 2)}`} />
                </td>
                <td className={`${td} text-right`}>{money(line.price, 2)}</td>
                <td className={`${td} text-right font-semibold`}>{money(lineNet(line), 2)}</td>
                <td className={td}>
                  <button type="button" className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600" onClick={() => onRemove(line.key)} aria-label="Remove line"><Trash2 size={15} /></button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
