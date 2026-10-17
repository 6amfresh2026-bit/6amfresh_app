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
        <ul className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded border border-gray-200 bg-white shadow-lg">
          {matches.map((it, i) => (
            <li
              key={it.id}
              onMouseDown={() => pick(it)}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-center justify-between px-3 py-2 text-sm ${i === active ? "bg-sky-50" : ""}`}
            >
              <span>
                <span className="font-medium text-gray-800">{it.name}</span>
                {it.barcode || it.sku ? <span className="ml-2 text-xs text-gray-400">{it.barcode || it.sku}</span> : null}
                {it.stockQty != null && Number(it.stockQty) <= 0 ? <span className="ml-2 text-xs text-red-500">out of stock</span> : null}
              </span>
              <span className="text-gray-700">₹{money(it.price, 2)}</span>
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
