import { useState, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { CheckCircle2 } from "lucide-react"
import { restaurantAPI } from "@food/api"
import { cn } from "@food/utils/utils"

const extractRestaurant = (response) =>
  response?.data?.data?.restaurant ||
  response?.data?.restaurant ||
  response?.data?.data?.user ||
  response?.data?.user ||
  response?.data?.data ||
  null

const extractMenuCount = (response) => {
  const data = response?.data?.data || response?.data || {}
  if (Array.isArray(data?.items)) return data.items.length
  if (Array.isArray(data?.foods)) return data.foods.length
  if (Array.isArray(data)) return data.length
  if (typeof data?.total === "number") return data.total
  // The seller menu endpoint answers { menu: { sections: [{ items: [...] }] } },
  // not a flat list, so none of the shapes above ever matched it and this step
  // read "no items" for a store with a full catalogue.
  const sections = data?.menu?.sections
  if (Array.isArray(sections)) {
    return sections.reduce((n, section) => {
      const own = Array.isArray(section?.items) ? section.items.length : 0
      const nested = Array.isArray(section?.subsections)
        ? section.subsections.reduce((m, sub) => m + (Array.isArray(sub?.items) ? sub.items.length : 0), 0)
        : 0
      return n + own + nested
    }, 0)
  }
  return 0
}

/** First-run onboarding checklist for a brand-new seller — mirrors the admin
 * panel's "Getting Started" widget so both sides of the app guide setup the
 * same way. Hides itself once every step is done. */
export default function SellerGettingStarted() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [restaurant, setRestaurant] = useState(null)
  const [menuItemCount, setMenuItemCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [restRes, menuRes] = await Promise.all([
          restaurantAPI.getCurrentRestaurant().catch(() => null),
          restaurantAPI.getMenu({ limit: 1 }).catch(() => null),
        ])
        if (cancelled) return
        setRestaurant(extractRestaurant(restRes))
        setMenuItemCount(extractMenuCount(menuRes))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  if (loading) return null

  // The profile response folds the address into `location`; there is no
  // top-level address / addressLine1, so reading those never found one.
  const loc = restaurant?.location
  const hasAddress = Boolean(
    restaurant?.address || restaurant?.addressLine1 ||
    loc?.formattedAddress || loc?.address || loc?.addressLine1
  )
  const hasProfile = hasAddress && Boolean(restaurant?.fssaiNumber)
  const hasMenu = menuItemCount > 0
  const hasZone = Boolean(restaurant?.zoneId)
  const hasBankDetails = Boolean(restaurant?.accountNumber && restaurant?.ifscCode)

  const steps = [
    {
      title: "Complete Your Outlet Profile",
      description: "Add your address and FSSAI number so customers and admin can verify your outlet.",
      completed: hasProfile,
      path: "/seller/outlet-info",
    },
    {
      title: "Add Your Menu Items",
      description: "Upload your product catalogue with prices, descriptions, and images.",
      completed: hasMenu,
      path: "/seller/menu-categories",
    },
    {
      title: "Set Your Delivery Zone",
      description: "Choose the zone you deliver to so customers nearby can find you.",
      completed: hasZone,
      path: "/seller/zone-setup",
    },
    {
      title: "Add Your Bank Details",
      description: "Set up your payout account so you get paid for completed orders.",
      completed: hasBankDetails,
      path: "/seller/update-bank-details",
    },
  ]

  const percent = Math.round((steps.filter((s) => s.completed).length / steps.length) * 100)
  if (percent >= 100) return null

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden mb-4">
      <div className="flex items-center justify-between px-5 pt-4">
        <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
          <span>🚀</span> Getting Started
        </h2>
        <span className="text-lg font-bold text-green-600">{percent}%</span>
      </div>
      <p className="px-5 pt-1 text-sm text-gray-500">
        Follow these steps to go live and start taking real orders.
      </p>
      <div className="mx-5 mt-3 h-1.5 rounded-full bg-gray-100">
        <div
          className="h-1.5 rounded-full bg-green-600 transition-all duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-3 divide-y divide-gray-100 border-t border-gray-100">
        {steps.map((step, idx) => {
          const isFirstIncomplete = !step.completed && steps.slice(0, idx).every((s) => s.completed)
          return (
            <div
              key={step.title}
              className={cn("flex items-center gap-4 px-5 py-3.5", isFirstIncomplete && "bg-green-50/60")}
            >
              <div
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                  step.completed
                    ? "bg-emerald-500 text-white"
                    : isFirstIncomplete
                      ? "bg-green-600 text-white"
                      : "border border-gray-300 text-gray-400"
                )}
              >
                {step.completed ? <CheckCircle2 className="h-4 w-4" /> : idx + 1}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900">{step.title}</p>
                <p className="text-sm text-gray-500">{step.description}</p>
              </div>
              <button
                type="button"
                onClick={() => navigate(step.path)}
                className="shrink-0 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
              >
                Review
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
