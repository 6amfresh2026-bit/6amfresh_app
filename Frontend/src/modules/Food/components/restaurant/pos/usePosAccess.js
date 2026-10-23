import { useCallback, useEffect, useState } from "react"

/** How often the till re-reads what this person may do, so an admin's change reaches it. */
export const POS_ACCESS_REFRESH_MS = 60 * 1000

/**
 * What the signed-in POS user is allowed to do. `can(key)` is true for the store owner and for an
 * admin running the till (no POS user), and until the answer arrives, so the till never flashes
 * locked. The server enforces every rule regardless; this only keeps the till from offering buttons
 * that would be refused.
 *
 * `ask` is api.posMe; `enabled` is false when there is nothing to ask (admin mode).
 */
export default function usePosAccess(ask, enabled = true) {
  const [posUser, setPosUser] = useState(null)

  useEffect(() => {
    if (!enabled || typeof ask !== "function") return undefined
    let cancelled = false
    const load = async () => {
      try {
        const res = await ask()
        if (!cancelled) setPosUser(res?.data?.data?.posUser || null)
      } catch {
        // keep the last answer; the server still enforces
      }
    }
    load()
    const timer = setInterval(load, POS_ACCESS_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  const can = useCallback((key) => !posUser || (posUser.permissions || []).includes(key), [posUser])
  return { can, posUser, limits: posUser?.limits || null }
}
