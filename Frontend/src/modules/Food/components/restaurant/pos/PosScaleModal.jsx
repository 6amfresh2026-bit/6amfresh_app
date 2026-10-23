import PosModal from "./PosModal"
import { BAUD_RATES, SCALE_UNITS } from "./scaleParser"
import { serialSupported } from "./useWeighingScale"

const STATUS_TEXT = {
  disconnected: "Not connected",
  connecting: "Connecting…",
  connected: "Connected",
  demo: "Demo scale",
  error: "Problem",
}

const field = "h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm outline-none focus:border-emerald-500"

/**
 * Weighing scale: connect a USB / RS-232 scale, or try the demo scale. The reading shown here is
 * exactly what the till will bill for a weighed product.
 */
export default function PosScaleModal({ scale, onClose }) {
  const { status, error, reading, settings, saveSettings, connect, startDemo, disconnect } = scale
  const live = status === "connected" || status === "demo"

  return (
    <PosModal
      title="⚖ Weighing scale"
      onClose={onClose}
      width="max-w-md"
      footer={
        <button type="button" onClick={onClose} className="rounded-lg bg-emerald-700 px-6 py-2 text-sm font-semibold text-white hover:bg-emerald-800">
          Done
        </button>
      }
    >
      <p className="mb-3 text-xs text-gray-500">Connect a USB / RS-232 scale, or use a keyboard-type scale.</p>

      <div className="rounded-lg bg-gray-100 p-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-gray-600">Status</span>
          <span className={`font-semibold ${live ? "text-emerald-700" : status === "error" ? "text-red-600" : "text-gray-900"}`}>{STATUS_TEXT[status]}</span>
        </div>
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-gray-600">Reading</span>
          <span className="font-semibold text-gray-900" data-testid="scale-reading">
            {reading ? (
              <>
                {reading.kg.toFixed(3)} kg
                {!reading.stable && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">settling…</span>}
              </>
            ) : "—"}
          </span>
        </div>
      </div>
      {error ? <p className="mt-2 text-xs text-red-600" role="alert">{error}</p> : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {live ? (
          <button type="button" onClick={disconnect} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">
            Disconnect
          </button>
        ) : (
          <button type="button" onClick={connect} disabled={status === "connecting"} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">
            Connect scale
          </button>
        )}
        {status !== "demo" && (
          <button type="button" onClick={startDemo} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">
            Use demo scale
          </button>
        )}
      </div>
      {!serialSupported() && (
        <p className="mt-2 text-xs text-amber-700">This browser cannot connect a USB scale. Chrome or Edge can; keyboard-type scales and the demo scale work anywhere.</p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-semibold text-gray-700">
          Baud rate (check the scale manual)
          <select value={settings.baudRate} onChange={(e) => saveSettings({ baudRate: Number(e.target.value) })} disabled={live} className={`${field} mt-1`}>
            {BAUD_RATES.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <label className="block text-xs font-semibold text-gray-700">
          Unit sent when the scale shows only a number
          <select value={settings.unit} onChange={(e) => saveSettings({ unit: e.target.value })} disabled={live} className={`${field} mt-1`}>
            {SCALE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </label>
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-gray-500">
        Set the scale to continuous output. Lines like <b>ST,GS, 1.250 kg</b> or <b>+001.250kg</b> are understood. Scales that type like a
        keyboard need no connection: click the weight box when weighing a vegetable and put the item on the scale.
      </p>
    </PosModal>
  )
}
