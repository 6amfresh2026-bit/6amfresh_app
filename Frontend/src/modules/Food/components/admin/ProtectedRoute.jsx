import { useEffect, useRef, useState } from "react"
import { Navigate, useLocation } from "react-router-dom"
import { adminAPI } from "@food/api"
import {
  clearModuleAuth,
  ensureValidAccessToken,
  getCurrentUser,
  isModuleAuthenticated,
  setAuthData,
} from "@food/utils/auth"
import { canAccessAdminPath, findFirstAllowedAdminPath } from "@food/utils/adminRbac"

export default function ProtectedRoute({ children }) {
  const location = useLocation()
  const [status, setStatus] = useState(() =>
    isModuleAuthenticated("admin") ? "checking" : "deny"
  )
  /**
   * Whether this session has been vouched for at least once.
   *
   * The profile is re-synced on every navigation, and that used to go back
   * through "checking" each time -- which renders a bare placeholder instead
   * of the children, tearing down AdminLayout and rebuilding it. The sidebar
   * went with it, so its scroll position reset to the top on every click and
   * a menu item far down the list was unreachable in one go.
   *
   * After the first successful check the re-sync runs in the background: a
   * revoked admin is still thrown out the moment the API says 401, but a
   * still-valid one never sees the panel flicker.
   */
  const verifiedOnce = useRef(false)

  useEffect(() => {
    let isMounted = true

    const syncAdminProfile = async () => {
      if (!isModuleAuthenticated("admin")) {
        if (isMounted) setStatus("deny")
        return
      }

      if (isMounted && !verifiedOnce.current) setStatus("checking")

      const accessToken = await ensureValidAccessToken("admin")
      if (!accessToken) {
        if (isMounted) setStatus("deny")
        return
      }

      try {
        const res = await adminAPI.getCurrentAdmin()
        const user =
          res?.data?.data?.user ??
          res?.data?.user ??
          res?.data?.data ??
          res?.data
        const token = localStorage.getItem("admin_accessToken")
        const refreshToken = localStorage.getItem("admin_refreshToken")
        if (token && user) {
          setAuthData("admin", token, user, refreshToken)
          window.dispatchEvent(new Event("adminAuthChanged"))
        }
        if (isMounted) {
          verifiedOnce.current = true
          setStatus("ok")
        }
      } catch (error) {
        // Only force logout on auth failure — keep session on network/server blips.
        const statusCode = error?.response?.status
        if (statusCode === 401 || statusCode === 403) {
          clearModuleAuth("admin")
          if (isMounted) setStatus("deny")
          return
        }
        if (isMounted) {
          verifiedOnce.current = true
          setStatus("ok")
        }
      }
    }

    syncAdminProfile()

    return () => {
      isMounted = false
    }
  }, [location.pathname])

  if (status === "checking") {
    return <div className="min-h-screen bg-neutral-100" />
  }

  if (status === "deny") {
    return <Navigate to="/admin/login" state={{ from: location.pathname }} replace />
  }

  const adminUser = getCurrentUser("admin")
  if (!canAccessAdminPath(location.pathname, "view")) {
    return <Navigate to={findFirstAllowedAdminPath(adminUser)} replace />
  }

  return children
}
