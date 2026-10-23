import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Wifi, WifiOff, Scale, Printer, Settings, Cloud, Trash2, Maximize2, Minimize2, X, LogOut, PanelLeft, Headset } from "lucide-react"
import { getCompanyName, getModuleLogoUrl } from "@food/utils/businessSettings"
import { POS_ORDER_TABS } from "./posOrderStatus"

const iconBtn = "rounded p-1.5 text-gray-600 hover:bg-white/70 hover:text-gray-900 disabled:opacity-40"

/**
 * The strip across the top of the till: the shop's order book by status, who
 * is ringing the sale up, and the row of utility icons on the right.
 */
export default function PosTopBar({
  orderStatus,
  onOrderStatus,
  salesman,
  salesmen,
  onSalesman,
  autoPrint,
  onAutoPrint,
  onPrintLast,
  onScale,
  scaleStatus = "disconnected",
  onSync,
  onClearBill,
  hasLines,
  syncing,
  onExit,
}) {
  const navigate = useNavigate()
  // Leaving the till runs the register-close flow when the parent provides it.
  const exitPos = () => (onExit ? onExit() : navigate("/seller/dashboard"))
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine))
  const [fullscreen, setFullscreen] = useState(() => Boolean(document.fullscreenElement))
  const companyName = getCompanyName() || "Store"
  const logoUrl = getModuleLogoUrl("restaurant")

  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    const fs = () => setFullscreen(Boolean(document.fullscreenElement))
    window.addEventListener("online", up)
    window.addEventListener("offline", down)
    document.addEventListener("fullscreenchange", fs)
    return () => {
      window.removeEventListener("online", up)
      window.removeEventListener("offline", down)
      document.removeEventListener("fullscreenchange", fs)
    }
  }, [])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.()
    else document.documentElement.requestFullscreen?.()
  }

  return (
    // Wraps to a second line rather than squeezing everything on one: a flex
    // row that cannot fit compresses its children instead of breaking, and the
    // squeezed result is worse than a second line.
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-[#eaf1f8] px-3 py-1.5 text-sm">
      <button type="button" className={iconBtn} onClick={exitPos} title="Back to dashboard">
        <PanelLeft size={18} />
      </button>

      <div className="flex shrink-0 items-center gap-2">
        {logoUrl ? <img src={logoUrl} alt="" className="h-7 w-auto object-contain" /> : null}
        <span className="text-xl font-extrabold tracking-tight text-[#2b3a67]">{companyName}<span className="text-sky-500">.</span></span>
      </div>

      {/* The shop's order book, one tap away. shrink-0 and no wrap: squeezed,
          eight pills stack one per line and swallow the screen the cart needs. */}
      <div className="flex shrink-0 items-center gap-1.5">
        {POS_ORDER_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => onOrderStatus(t.key)}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-semibold transition-colors ${
              orderStatus === t.key ? "bg-[#FA0272] text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[15px] text-gray-800">Salesman:</span>
        <select
          value={salesman}
          onChange={(e) => onSalesman(e.target.value)}
          // The one field allowed to give way before the bar wraps — a
          // truncated name is still readable.
          className="h-8 w-[180px] min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 text-sm text-gray-700 outline-none"
        >
          {salesmen.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <label className="flex items-center gap-2" title="Print the bill automatically after every sale">
        <span className="relative inline-block h-5 w-10">
          <input type="checkbox" className="peer sr-only" checked={autoPrint} onChange={(e) => onAutoPrint(e.target.checked)} />
          <span className="absolute inset-0 rounded-full bg-gray-300 transition peer-checked:bg-sky-500" />
          <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition peer-checked:translate-x-5" />
        </span>
      </label>

      <button
        type="button"
        onClick={() => navigate("/seller/help-centre/support")}
        className="flex items-center gap-1.5 text-[15px] text-gray-800 hover:text-sky-600"
      >
        <Headset size={18} className="text-gray-500" /> Support Desk
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <span className={iconBtn} title={online ? "Online" : "Offline — sales will fail until the connection is back"}>
          {online ? <Wifi size={18} className="text-emerald-500" /> : <WifiOff size={18} className="text-red-500" />}
        </span>
        <button type="button" className={`${iconBtn} relative`} onClick={onScale} title={`Weighing scale — ${scaleStatus === "connected" ? "connected" : scaleStatus === "demo" ? "demo" : "not connected"}`} aria-label="Weighing scale">
          <Scale size={18} />
          <span className={`absolute bottom-0.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full ${scaleStatus === "connected" || scaleStatus === "demo" ? "bg-emerald-500" : scaleStatus === "error" ? "bg-red-500" : "bg-gray-300"}`} />
        </button>
        <button type="button" className={iconBtn} onClick={onPrintLast} title="Print last bill"><Printer size={18} /></button>
        <button type="button" className={iconBtn} onClick={() => navigate("/seller/outlet-info")} title="Outlet settings"><Settings size={18} /></button>
        <button type="button" className={iconBtn} onClick={onSync} disabled={syncing} title="Reload products"><Cloud size={18} className={syncing ? "animate-pulse" : ""} /></button>
        <button type="button" className={iconBtn} onClick={onClearBill} disabled={!hasLines} title="Clear bill"><Trash2 size={18} /></button>
        <button type="button" className={iconBtn} onClick={toggleFullscreen} title={fullscreen ? "Exit full screen" : "Full screen"}>
          {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
        </button>
        <button type="button" className={iconBtn} onClick={onClearBill} disabled={!hasLines} title="New bill"><X size={18} /></button>
        <button type="button" className={iconBtn} onClick={exitPos} title="Exit POS"><LogOut size={18} /></button>
      </div>
    </header>
  )
}
