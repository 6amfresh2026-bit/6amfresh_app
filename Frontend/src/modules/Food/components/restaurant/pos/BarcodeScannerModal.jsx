import { useEffect, useRef, useState } from "react"
import PosModal, { btnLight } from "./PosModal"

/**
 * Camera barcode scanner for the till.
 *
 * Stays open and reports every code it reads to `onScan(code)`, which answers
 * { ok, message } so the cashier sees what each scan did ("Added Milk", "No product
 * with barcode ...") without taking their eyes off the counter. A scan of the same
 * code within `REPEAT_MS` is ignored: held steady, a camera reads the same barcode
 * many times a second, and that must add the product once, not thirty times. To buy
 * two, scan it again after a moment.
 *
 * The decoder (zxing) is imported only when this opens, so the till does not carry it
 * until someone uses the camera. A USB scanner never needs any of this: it types into
 * the search box.
 */
const REPEAT_MS = 1500
const FORMATS = ["EAN_13", "EAN_8", "UPC_A", "UPC_E", "CODE_128", "CODE_39", "CODE_93", "ITF"]

const cameraErrorMessage = (err) => {
  if (!window.isSecureContext) return "The camera only works on a secure (https) page."
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera access was blocked. Allow the camera for this site in the browser's address bar, then try again."
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera was found on this device."
    case "NotReadableError":
      return "The camera is in use by another app. Close it and try again."
    default:
      return "The camera could not be started."
  }
}

/** A short beep and a buzz: a scan is something you hear, not something you check the screen for. */
const confirmScan = (ok) => {
  try {
    navigator.vibrate?.(ok ? 40 : [60, 40, 60])
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = ok ? 1100 : 300
    gain.gain.value = 0.08
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + (ok ? 0.08 : 0.2))
    osc.onended = () => ctx.close()
  } catch {
    /* feedback is a nicety; never let it break a scan */
  }
}

export default function BarcodeScannerModal({ onScan, onClose }) {
  const videoRef = useRef(null)
  const last = useRef({ code: "", at: 0 })
  const onScanRef = useRef(onScan)
  const [error, setError] = useState("")
  const [starting, setStarting] = useState(true)
  const [feed, setFeed] = useState([])

  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])

  useEffect(() => {
    let controls = null
    let cancelled = false

    const handle = (code) => {
      const now = Date.now()
      if (code === last.current.code && now - last.current.at < REPEAT_MS) {
        last.current.at = now // still in view: keep the window open, do not re-add
        return
      }
      last.current = { code, at: now }
      const outcome = onScanRef.current?.(code) || { ok: false, message: `Scanned ${code}` }
      confirmScan(outcome.ok)
      setFeed((prev) => [{ id: now, code, ...outcome }, ...prev].slice(0, 5))
    }

    ;(async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("no camera api"), { name: "NotFoundError" })
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
          import("@zxing/browser"),
          import("@zxing/library"),
        ])
        if (cancelled) return
        const hints = new Map([
          [DecodeHintType.POSSIBLE_FORMATS, FORMATS.map((f) => BarcodeFormat[f])],
          [DecodeHintType.TRY_HARDER, true],
        ])
        const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 80 })
        controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } },
          videoRef.current,
          (result) => {
            // Errors here are just "nothing readable in this frame", which is most frames.
            if (result) handle(result.getText())
          },
        )
        if (cancelled) controls.stop()
        else setStarting(false)
      } catch (err) {
        if (!cancelled) {
          setError(cameraErrorMessage(err))
          setStarting(false)
        }
      }
    })()

    return () => {
      cancelled = true
      controls?.stop()
    }
  }, [])

  return (
    <PosModal
      title="Scan with camera"
      onClose={onClose}
      width="max-w-md"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-gray-500">Point the camera at a barcode. Scan again to add another.</span>
          <button type="button" className={btnLight} onClick={onClose}>Done</button>
        </div>
      }
    >
      {error ? (
        <p className="rounded bg-red-50 px-3 py-4 text-sm text-red-700" role="alert">{error}</p>
      ) : (
        <div className="relative overflow-hidden rounded bg-black">
          <video ref={videoRef} className="aspect-[4/3] w-full object-cover" muted playsInline />
          {starting ? <div className="absolute inset-0 flex items-center justify-center text-sm text-white">Starting camera…</div> : null}
          {/* a guide to aim with; the whole frame is scanned, not just this box */}
          <div className="pointer-events-none absolute inset-x-6 top-1/2 h-24 -translate-y-1/2 rounded border-2 border-white/70" />
        </div>
      )}

      {feed.length ? (
        <ul className="mt-3 space-y-1" aria-live="polite">
          {feed.map((f, i) => (
            <li
              key={f.id}
              className={`flex items-center justify-between rounded px-2 py-1 text-sm ${f.ok ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"} ${i === 0 ? "font-medium" : "opacity-70"}`}
            >
              <span>{f.ok ? "✓" : "✗"} {f.message}</span>
              <span className="ml-2 font-mono text-xs opacity-70">{f.code}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </PosModal>
  )
}
