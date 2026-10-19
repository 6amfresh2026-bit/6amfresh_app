import { useEffect } from "react"
import { X } from "lucide-react"

/** The one dialog shell every till pop-up uses. Esc closes; the backdrop does too. */
export default function PosModal({ title, onClose, children, width = "max-w-2xl", footer = null }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
      <div
        className={`w-full ${width} rounded-lg bg-white shadow-xl flex flex-col max-h-[90vh]`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold text-gray-800">{title}</h2>
          {/* A modal that can't be dismissed (onClose null) shouldn't show a
              dead X — its footer carries the only ways out. */}
          {onClose ? (
            <button type="button" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label="Close">
              <X size={18} />
            </button>
          ) : null}
        </div>
        <div className="overflow-y-auto px-4 py-3 text-sm">{children}</div>
        {footer ? <div className="border-t px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  )
}

export const btnDark = "inline-flex items-center justify-center gap-1 rounded bg-[#1f1f1f] px-3 py-2 text-sm font-medium text-white hover:bg-black disabled:opacity-40 disabled:cursor-not-allowed"
export const btnLight = "inline-flex items-center justify-center gap-1 rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
export const inputCls = "w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-200"
