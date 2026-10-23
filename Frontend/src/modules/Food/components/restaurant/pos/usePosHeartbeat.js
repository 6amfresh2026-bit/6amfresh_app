import { useEffect, useRef } from "react"

/** How often the till says "still here". The server treats ~90 s of silence as offline. */
export const POS_HEARTBEAT_MS = 20000

/**
 * Keeps this store's POS "online" for as long as the till is open.
 *
 * Checks in at once, then every 20 s, and again whenever the tab comes back to the front or the
 * network returns (a hidden tab's timers are slowed by the browser). A failed beat is ignored: the
 * next one tries again, and the server only counts the till offline after several misses.
 * `ping` is read through a ref so a new function each render does not restart the timer.
 */
export default function usePosHeartbeat(ping) {
  const pingRef = useRef(ping)
  useEffect(() => {
    pingRef.current = ping
  }, [ping])

  useEffect(() => {
    const beat = () => {
      try {
        Promise.resolve(pingRef.current?.()).catch(() => {})
      } catch {
        /* never let a heartbeat take the till down */
      }
    }
    beat()
    const timer = setInterval(beat, POS_HEARTBEAT_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") beat()
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("online", beat)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("online", beat)
    }
  }, [])
}
