import { useCallback, useEffect, useRef, useState } from "react"
import { createLineBuffer, parseScaleLine } from "./scaleParser"

const STORE_KEY = "pos_scale_settings"
/** A reading older than this is the pan being empty or the cable out, not a weight to bill. */
export const READING_FRESH_MS = 3000

const loadSettings = () => {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}")
    return { baudRate: Number(s.baudRate) || 9600, unit: s.unit === "g" ? "g" : "kg" }
  } catch {
    return { baudRate: 9600, unit: "kg" }
  }
}

export const serialSupported = () => typeof navigator !== "undefined" && "serial" in navigator

/**
 * The till's weighing scale.
 *
 * Three ways to get a weight: a USB / RS-232 scale over Web Serial (Chrome and Edge, on https or
 * localhost), a built-in demo scale for trying the till without hardware, and a keyboard-type scale,
 * which needs nothing here because it types into whatever box has focus.
 *
 * `weight()` is what the till bills: the latest reading, only when it is stable, above zero and
 * fresh. Anything else is null, so a pan that is still swinging can never be sold.
 */
export default function useWeighingScale() {
  const [settings, setSettings] = useState(loadSettings)
  const [status, setStatus] = useState("disconnected") // disconnected | connecting | connected | demo | error
  const [error, setError] = useState("")
  const [reading, setReading] = useState(null) // { kg, stable, at }
  const portRef = useRef(null)
  const readerRef = useRef(null)
  const demoRef = useRef(null)
  const aliveRef = useRef(true)

  const saveSettings = useCallback((patch) => {
    setSettings((s) => {
      const next = { ...s, ...patch }
      try { localStorage.setItem(STORE_KEY, JSON.stringify(next)) } catch { /* private mode: not remembered */ }
      return next
    })
  }, [])

  const stopDemo = useCallback(() => {
    if (demoRef.current) clearInterval(demoRef.current)
    demoRef.current = null
  }, [])

  const disconnect = useCallback(async () => {
    stopDemo()
    try { await readerRef.current?.cancel() } catch { /* already closed */ }
    readerRef.current = null
    try { await portRef.current?.close() } catch { /* already closed */ }
    portRef.current = null
    if (aliveRef.current) {
      setStatus("disconnected")
      setReading(null)
    }
  }, [stopDemo])

  const connect = useCallback(async () => {
    if (!serialSupported()) {
      setStatus("error")
      setError("This browser cannot talk to a scale. Use Chrome or Edge, or use the demo scale.")
      return
    }
    setError("")
    setStatus("connecting")
    try {
      await disconnect()
      const port = await navigator.serial.requestPort()
      await port.open({ baudRate: settings.baudRate })
      portRef.current = port
      setStatus("connected")

      const feed = createLineBuffer((line) => {
        const parsed = parseScaleLine(line, settings.unit)
        if (parsed && aliveRef.current) setReading({ ...parsed, at: Date.now() })
      })
      const decoder = new TextDecoder()
      const reader = port.readable.getReader()
      readerRef.current = reader
      ;(async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            if (value) feed(decoder.decode(value, { stream: true }))
          }
        } catch (err) {
          if (aliveRef.current && portRef.current) { setStatus("error"); setError(err?.message || "The scale stopped sending.") }
        } finally {
          try { reader.releaseLock() } catch { /* released */ }
        }
      })()
    } catch (err) {
      portRef.current = null
      if (!aliveRef.current) return
      // Closing the chooser without picking a device is not a failure worth a red banner.
      if (err?.name === "NotFoundError") { setStatus("disconnected"); return }
      setStatus("error")
      setError(err?.name === "InvalidStateError" ? "That port is already open in another app." : err?.message || "Could not open the scale.")
    }
  }, [disconnect, settings.baudRate, settings.unit])

  const startDemo = useCallback(async () => {
    await disconnect()
    setError("")
    setStatus("demo")
    let tick = 0
    demoRef.current = setInterval(() => {
      tick += 1
      // Settles on 1.250 kg, with a swing now and then so the "unstable" state can be seen.
      const swinging = tick % 8 === 0
      const kg = swinging ? 1.18 + Math.random() * 0.12 : 1.25
      setReading({ kg: Math.round(kg * 1000) / 1000, stable: !swinging, at: Date.now() })
    }, 600)
  }, [disconnect])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (demoRef.current) clearInterval(demoRef.current)
      try { readerRef.current?.cancel() } catch { /* closed */ }
      try { portRef.current?.close() } catch { /* closed */ }
    }
  }, [])

  // The reading ages even when nothing new arrives, so a stale one stops counting by itself.
  const [, force] = useState(0)
  useEffect(() => {
    if (status !== "connected" && status !== "demo") return undefined
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [status])

  const live = status === "connected" || status === "demo"
  const fresh = Boolean(reading) && Date.now() - reading.at <= READING_FRESH_MS
  const weight = useCallback(
    () => (live && reading && fresh && reading.stable && reading.kg > 0 ? reading.kg : null),
    [live, reading, fresh],
  )

  return { status, error, reading: live && fresh ? reading : null, settings, saveSettings, connect, startDemo, disconnect, weight }
}
