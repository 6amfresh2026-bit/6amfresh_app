import { useEffect, useState } from "react"
import { restaurantAPI } from "@food/api"

/** How often the customer app re-asks. The server's answer is uncached, so this is how fast changes land. */
export const APP_STATUS_REFRESH_MS = 10000

/**
 * Whether customers can order from a store right now, and whether instant delivery is live.
 *
 * Asks the server, which runs the same check as checkout, so what the app shows and what checkout
 * accepts cannot disagree. Re-asks every few seconds while the page is visible and again when it
 * comes back to the front, so the admin closing a store, or a till going offline, reaches an open
 * cart quickly. A failed request keeps the last answer: if the server cannot be reached the app
 * does not suddenly decide the store is shut. Returns null until the first answer.
 *
 * `{ open, reason, message, instantLive }`, with `open` and `instantLive` meant to be tested as
 * `=== false`, so an unknown answer never blocks anyone.
 */
export default function useStoreAppStatus(restaurantId) {
  const [state, setState] = useState({ id: null, status: null })

  useEffect(() => {
    if (!restaurantId) return undefined
    let cancelled = false

    const ask = async () => {
      try {
        const res = await restaurantAPI.getStoreAppStatus(restaurantId)
        const data = res?.data?.data
        if (!cancelled && data) setState({ id: String(restaurantId), status: data })
      } catch {
        /* keep the last answer */
      }
    }

    ask()
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") ask()
    }, APP_STATUS_REFRESH_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") ask()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [restaurantId])

  // An answer about another store (the cart changed) is not an answer about this one.
  return restaurantId && state.id === String(restaurantId) ? state.status : null
}
