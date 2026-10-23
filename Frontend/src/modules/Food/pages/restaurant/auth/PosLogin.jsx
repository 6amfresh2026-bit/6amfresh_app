import { useEffect, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { motion, useReducedMotion } from "framer-motion"
import { Eye, EyeOff, Loader2, Shield } from "lucide-react"
import { Button } from "@food/components/ui/button"
import { Label } from "@food/components/ui/label"
import { restaurantAPI } from "@food/api"
import { useCompanyName } from "@food/hooks/useCompanyName"
import { loadBusinessSettings, getModuleLogoUrl } from "@food/utils/businessSettings"
import RestaurantPartnerHero from "@food/components/restaurant/auth/RestaurantPartnerHero"
import quickSpicyLogo from "@food/assets/6am-fresh-icon.png"
import { POS_FLOW } from "@food/utils/sellerAuthFlow"
import { setAuthData } from "@food/utils/auth"

const THEME = "#2563EB"

/**
 * The till's own sign-in: the username and password an admin created under "POS users".
 * It signs the cashier into their store's POS only; the store owner keeps signing in to the seller
 * panel with the phone number and OTP.
 */
export default function PosLogin({ flow = POS_FLOW }) {
  const companyName = useCompanyName()
  const navigate = useNavigate()
  const prefersReducedMotion = useReducedMotion()
  const [logoUrl, setLogoUrl] = useState(() => getModuleLogoUrl("restaurant") || quickSpicyLogo)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    loadBusinessSettings()
      .then(() => {
        const logo = getModuleLogoUrl("restaurant")
        if (logo) setLogoUrl(logo)
      })
      .catch(() => {})
  }, [])

  const canSubmit = username.trim().length > 0 && password.length > 0 && !submitting

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    setError("")
    setSubmitting(true)
    try {
      const response = await restaurantAPI.posLogin(username, password)
      const data = response?.data?.data || response?.data
      const { accessToken, refreshToken = null } = data || {}
      const store = data?.user ?? data?.restaurant
      if (!accessToken || !store) throw new Error("Sign in failed. Please try again.")
      setAuthData("restaurant", accessToken, { ...store, posUser: data?.posUser || null }, refreshToken)
      window.dispatchEvent(new Event("restaurantAuthChanged"))
      navigate(flow.homePath, { replace: true })
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || "Sign in failed. Please try again.")
      setPassword("")
    } finally {
      setSubmitting(false)
    }
  }

  const formMotion = prefersReducedMotion
    ? {}
    : {
        initial: { opacity: 0, y: 12 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.35, ease: "easeOut" },
      }

  const inputClass =
    "h-12 w-full rounded-xl border border-gray-200 bg-white px-4 text-base font-medium text-gray-900 shadow-sm outline-none transition-all placeholder:text-gray-400 focus:ring-2 focus:ring-[#2563EB]/30"

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-white">
      <div className="hidden h-full lg:block lg:w-1/2">
        <RestaurantPartnerHero themeColor={THEME} />
      </div>

      <div className="flex h-full w-full flex-col bg-[#F0F2F5] lg:w-1/2">
        <div className="relative shrink-0 overflow-hidden px-6 py-5 lg:hidden" style={{ backgroundColor: "#141018" }}>
          <div
            className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full blur-2xl"
            style={{ backgroundColor: `${THEME}35` }}
          />
          <div className="relative flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ backgroundColor: `${THEME}20` }}>
              <Shield className="h-3.5 w-3.5" style={{ color: THEME }} aria-hidden="true" />
            </div>
            <div>
              <p className="text-[10px] font-medium text-white/50">{flow.portalLabel}</p>
              <p className="text-sm font-semibold text-white">{companyName}</p>
            </div>
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center overflow-y-auto px-5 py-8 sm:px-10">
          <motion.div {...formMotion} className="my-auto w-full max-w-[380px]">
            <div className="mb-7 text-center lg:text-left">
              <div className="mb-5 flex justify-center lg:justify-start">
                <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
                  <img
                    src={logoUrl}
                    alt={`${companyName} logo`}
                    className="h-full w-full object-contain p-1"
                    onError={(e) => {
                      if (e.target.src !== quickSpicyLogo) e.target.src = quickSpicyLogo
                    }}
                  />
                </div>
              </div>
              <h2 className="text-2xl font-bold tracking-tight text-gray-900">{flow.title}</h2>
              <p className="mt-1 text-sm text-gray-500">Sign in with the username and password your admin gave you</p>
            </div>

            <form
              onSubmit={handleSubmit}
              className="rounded-2xl border border-gray-200 bg-white p-6 shadow-[0_4px_24px_rgba(0,0,0,0.08)] sm:p-7"
            >
              <div className="space-y-4">
                {error && (
                  <div role="alert" className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
                    {error}
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="pos-username" className="text-sm font-medium text-gray-700">
                    Username
                  </Label>
                  <input
                    id="pos-username"
                    type="text"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    autoFocus
                    placeholder="your.username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className={inputClass}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="pos-password" className="text-sm font-medium text-gray-700">
                    Password
                  </Label>
                  <div className="relative">
                    <input
                      id="pos-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={`${inputClass} pr-12`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-gray-400 hover:text-gray-600"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <Button
                  type="submit"
                  disabled={!canSubmit}
                  variant="ghost"
                  className="h-12 w-full cursor-pointer rounded-xl border-0 text-sm font-semibold text-white shadow-sm transition-all hover:opacity-90 disabled:opacity-50"
                  style={{ backgroundColor: THEME }}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Signing in...
                    </>
                  ) : (
                    "Sign in"
                  )}
                </Button>
              </div>
            </form>

            <p className="mt-5 text-center text-xs text-gray-500">
              Store owner?{" "}
              <Link to={flow.ownerLoginPath} className="font-semibold underline underline-offset-2" style={{ color: THEME }}>
                Sign in with your phone number
              </Link>
            </p>
          </motion.div>
        </div>
      </div>
    </div>
  )
}
