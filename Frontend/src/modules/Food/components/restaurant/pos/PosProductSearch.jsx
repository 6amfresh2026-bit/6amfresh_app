import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { ScanBarcode } from "lucide-react"
import { findItemByCode, matchesCode, money } from "./posUtils"

// The camera decoder is a few hundred KB; fetch it only when someone opens the scanner.
const BarcodeScannerModal = lazy(() => import("./BarcodeScannerModal"))

/**
 * "Scan Barcode/Enter Product Name".
 *
 * A scanner types the code and presses Enter, so an exact code match adds
 * without ever showing a list. Typing a name shows matches; Enter takes the
 * highlighted one. Focus returns here after every add so the next scan lands.
 *
 * The camera button opens a scanner for a phone or a laptop with no scanner gun.
 */
/** "9 in stock" under the price: kilograms for loose produce; amber when low, red when gone. */
function StockLabel({ item }) {
  if (item.stockQty == null) return <span className="block text-xs text-gray-400">stock not tracked</span>
  const qty = Number(item.stockQty) || 0
  if (qty <= 0) return <span className="block text-xs font-medium text-red-500">out of stock</span>
  const low = qty <= (Number(item.lowStockThreshold) || 0)
  const shown = Number.isInteger(qty) ? String(qty) : qty.toFixed(3)
  return <span className={`block text-xs ${low ? "font-medium text-amber-600" : "text-gray-500"}`}>{shown}{item.soldByWeight ? " kg" : ""} in stock</span>
}

/** "500 g · P035 · 2900000000353 · Staples › Sugar & salt": everything a cashier tells two lookalikes apart by. */
const subtitleOf = (it) =>
  [
    it.packSize || it.unit,
    it.itemCode,
    it.barcode || it.sku,
    [it.categoryName || it.category, it.subCategoryName].filter(Boolean).join(" › "),
  ]
    .filter(Boolean)
    .join(" · ") || "No barcode"

/** A small product picture; a neutral tile when there is none or it fails to load, so rows stay aligned. */
function ProductThumb({ src, name }) {
  const [failed, setFailed] = useState(false)
  const box = "h-11 w-11 shrink-0 rounded-xl border border-gray-200 bg-gray-50"
  if (!src || failed) {
    return (
      <span className={`${box} grid place-items-center text-sm font-semibold text-gray-400`} aria-hidden="true">
        {String(name || "?").trim().charAt(0).toUpperCase()}
      </span>
    )
  }
  return <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className={`${box} object-cover`} />
}

export default function PosProductSearch({ items, onAdd, autoFocus = true }) {
  const [q, setQ] = useState("")
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [cameraOpen, setCameraOpen] = useState(false)
  const inputRef = useRef(null)

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return []
    const exact = items.filter((it) => matchesCode(it, needle))
    if (exact.length) return exact
    return items
      .filter((it) => it.isAvailable !== false && it.approvalStatus !== "rejected")
      .filter((it) => String(it.name || "").toLowerCase().includes(needle))
      .slice(0, 8)
  }, [items, q])

  useEffect(() => setActive(0), [q])

  const pick = (item) => {
    if (!item) return
    onAdd(item)
    setQ("")
    setOpen(false)
    inputRef.current?.focus()
  }

  /** A code the camera read: add that product, and say what happened. */
  const onCameraScan = (code) => {
    const item = findItemByCode(items, code)
    if (!item) return { ok: false, message: "No product with this barcode" }
    onAdd(item)
    return { ok: true, message: `Added ${item.name}` }
  }

  const closeCamera = () => {
    setCameraOpen(false)
    inputRef.current?.focus()
  }

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, matches.length - 1)); setOpen(true) }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === "Enter") { e.preventDefault(); pick(matches[active]) }
    else if (e.key === "Escape") { setOpen(false) }
  }

  return (
    <div className="relative flex-1">
      <div className="flex gap-2">
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true) }}
          onFocus={() => q && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
          placeholder="Scan Barcode/Enter Product Name"
          className="h-10 w-full rounded border border-gray-300 bg-white px-3 text-[15px] text-gray-800 outline-none placeholder:text-gray-400 focus:border-sky-400"
        />
        <button
          type="button"
          onClick={() => setCameraOpen(true)}
          title="Scan with camera"
          aria-label="Scan with camera"
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded border border-gray-300 bg-white px-3 text-sm text-gray-700 hover:bg-gray-50"
        >
          <ScanBarcode size={18} />
          <span className="hidden sm:inline">Scan</span>
        </button>
      </div>
      {cameraOpen ? (
        <Suspense fallback={null}>
          <BarcodeScannerModal onScan={onCameraScan} onClose={closeCamera} />
        </Suspense>
      ) : null}
      {open && matches.length > 0 ? (
        <ul className="absolute z-30 mt-1 max-h-80 w-full overflow-auto rounded-2xl border border-emerald-100 bg-white shadow-xl">
          {matches.map((it, i) => (
            <li
              key={it.id}
              onMouseDown={() => pick(it)}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-center justify-between gap-4 border-b border-gray-100 px-3 py-2.5 last:border-b-0 ${i === active ? "bg-emerald-50" : ""}`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <ProductThumb src={it.image || (Array.isArray(it.images) ? it.images[0] : "")} name={it.name} />
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-bold text-gray-900">{it.name}</span>
                  <span className="block truncate text-xs text-gray-500">{subtitleOf(it)}</span>
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-[15px] font-bold text-gray-900">₹{money(it.price, 0)}{it.soldByWeight ? <span className="text-xs font-medium text-gray-500">/kg</span> : null}</span>
                <StockLabel item={it} />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {open && q.trim() && matches.length === 0 ? (
        <div className="absolute z-30 mt-1 w-full rounded border border-gray-200 bg-white px-3 py-2 text-sm text-gray-500 shadow-lg">No product matches "{q}"</div>
      ) : null}
    </div>
  )
}
