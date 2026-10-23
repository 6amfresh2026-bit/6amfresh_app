import { Suspense, lazy } from "react"
import { Navigate, Route, Routes } from "react-router-dom"
import AuthRedirect from "@food/components/AuthRedirect"
import Loader from "@food/components/Loader"
import ProtectedRoute from "@food/components/ProtectedRoute"
import useRestaurantAppTheme from "@food/hooks/useRestaurantAppTheme"
import { POS_FLOW } from "@food/utils/sellerAuthFlow"

const PointOfSale = lazy(() => import("@food/pages/restaurant/pos/PointOfSale"))
const PosLogin = lazy(() => import("@food/pages/restaurant/auth/PosLogin"))
const Login = lazy(() => import("@food/pages/restaurant/auth/Login"))
const OTP = lazy(() => import("@food/pages/restaurant/auth/OTP"))

/**
 * The point of sale, on its own address (/pos) instead of inside the seller panel (/seller/pos).
 *
 * It is a separate app with its own sign-in. Cashiers sign in at /pos/login with the username and
 * password an admin created under "POS users"; the store owner can also sign in at /pos/owner-login
 * with phone + OTP. Either way they land on the till, never on the seller panel.
 */
export default function PosRouter() {
  useRestaurantAppTheme()

  return (
    <Suspense fallback={<Loader />}>
      <Routes>
        <Route
          path="login"
          element={
            <AuthRedirect module="restaurant" redirectTo={POS_FLOW.homePath}>
              <PosLogin flow={POS_FLOW} />
            </AuthRedirect>
          }
        />
        <Route
          path="owner-login"
          element={
            <AuthRedirect module="restaurant" redirectTo={POS_FLOW.homePath}>
              <Login flow={POS_FLOW} />
            </AuthRedirect>
          }
        />
        <Route
          path="otp"
          element={
            <AuthRedirect module="restaurant" redirectTo={POS_FLOW.homePath}>
              <OTP flow={POS_FLOW} />
            </AuthRedirect>
          }
        />
        <Route
          path=""
          element={
            <ProtectedRoute requiredRole="restaurant" loginPath={POS_FLOW.loginPath}>
              <PointOfSale />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to={POS_FLOW.homePath} replace />} />
      </Routes>
    </Suspense>
  )
}
