import { useState, useEffect, useRef } from "react"
import { NavLink, useNavigate, useLocation } from "react-router-dom"
import {
  Store,
  FileText,
  Truck,
  Receipt,
  MessageSquare,
  LogOut,
  Building2,
  IndianRupee,
  Compass,
  CreditCard,
  LayoutDashboard,
  Monitor,
  ChevronDown,
  Gift,
  Palette,
  Settings as SettingsIcon,
} from "lucide-react"
import { restaurantAPI } from "@food/api"
import { getCompanyName, getModuleLogoUrl, getCachedSettings, loadBusinessSettings } from "@food/utils/businessSettings"
import brandIcon from "@food/assets/6am-fresh-icon.png"
import { logoutRestaurantSession } from "@food/utils/restaurantLogout"

const BASE = "/seller"

const extractRestaurantPayload = (response) =>
  response?.data?.data?.restaurant ||
  response?.data?.restaurant ||
  response?.data?.data?.user ||
  response?.data?.user ||
  response?.data?.data ||
  null

// Mirrors DeOnde's vendor sidebar grouping (Overview / Management "Outlet" /
// Delivery / Finance / Growth / Configuration), built only from routes that
// actually exist in RestaurantRouter.jsx — no placeholder links for pages
// (Cuisine "Brands"/"Item Labels", a Customers list) this panel doesn't have.
const sections = [
  {
    title: "OVERVIEW",
    items: [
      { name: "Dashboard", path: `${BASE}/dashboard`, icon: LayoutDashboard, exact: true },
      { name: "POS", path: `${BASE}/pos`, icon: Monitor, exact: true },
      {
        name: "Orders",
        icon: FileText,
        type: "expandable",
        subItems: [
          { name: "Live orders", path: BASE, exact: true },
          { name: "Order history", path: `${BASE}/orders/all` },
        ],
      },
    ],
  },
  {
    title: "MANAGEMENT",
    items: [
      {
        name: "Outlet",
        icon: Store,
        type: "expandable",
        subItems: [
          { name: "All Outlet", path: `${BASE}/manage-outlets` },
          { name: "Menu", path: `${BASE}/inventory` },
          { name: "Cuisine", path: `${BASE}/edit-cuisines` },
          { name: "Categories", path: `${BASE}/menu-categories` },
          { name: "Reviews", path: `${BASE}/ratings-reviews` },
        ],
      },
      {
        name: "Delivery",
        icon: Truck,
        type: "expandable",
        subItems: [
          { name: "Delivery settings", path: `${BASE}/delivery-settings` },
          { name: "Delivery fleet", path: `${BASE}/delivery-fleet` },
          { name: "Rush hour", path: `${BASE}/rush-hour` },
          { name: "Zone setup", path: `${BASE}/zone-setup` },
        ],
      },
      { name: "Explore", path: `${BASE}/explore`, icon: Compass },
    ],
  },
  {
    title: "GROWTH",
    items: [{ name: "Offers & Coupons", path: `${BASE}/coupon`, icon: Gift }],
  },
  {
    title: "FINANCE",
    items: [
      { name: "Payout", path: `${BASE}/hub-finance`, icon: IndianRupee, exact: true },
      { name: "Invoices", path: `${BASE}/hub-finance?tab=invoices`, icon: Receipt },
      { name: "Bank details", path: `${BASE}/update-bank-details`, icon: Building2 },
      { name: "Subscription", path: `${BASE}/subscription`, icon: CreditCard },
    ],
  },
  {
    title: "CONFIGURATION",
    items: [
      { name: "Outlet info", path: `${BASE}/outlet-info`, icon: Palette },
      {
        name: "Settings",
        icon: SettingsIcon,
        type: "expandable",
        subItems: [
          { name: "Outlet timings", path: `${BASE}/outlet-timings` },
          { name: "Support", path: `${BASE}/help-centre/support` },
          { name: "Share your feedback", path: `${BASE}/share-feedback` },
        ],
      },
    ],
  },
]

// Quick-access icon row pinned above the profile footer. Only shortcuts that
// map to a real existing page are here — no placeholder tiles for features
// (POS, a dedicated Apps page) this panel doesn't have yet.
const MORE_TOOLS = [
  { label: "Chat", icon: MessageSquare, path: `${BASE}/help-centre/support` },
  { label: "Subscr.", icon: CreditCard, path: `${BASE}/subscription` },
]

function isItemActive(item, pathname, search) {
  const [itemPath, itemQuery = ""] = String(item.path || "").split("?")
  const searchParams = new URLSearchParams(search)
  const itemParams = new URLSearchParams(itemQuery)

  const pathMatches = item.exact
    ? pathname === itemPath || pathname === `${itemPath}/`
    : pathname === itemPath || pathname.startsWith(`${itemPath}/`)

  if (!pathMatches) return false

  // Items with query params only active when those params match
  if (itemQuery) {
    for (const [key, value] of itemParams.entries()) {
      if (searchParams.get(key) !== value) return false
    }
    return true
  }

  // Exact path items without query should not match when a competing tab query is present
  // e.g. Reviews vs Complaints, Payout vs Invoices
  if (item.exact && (pathname === itemPath || pathname === `${itemPath}/`)) {
    if (itemPath.endsWith("/feedback") && searchParams.get("tab") === "complaints") {
      return false
    }
    if (itemPath.endsWith("/hub-finance") && searchParams.get("tab") === "invoices") {
      return false
    }
  }

  return true
}

export default function DesktopSidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const navScrollRef = useRef(null)
  const [restaurantData, setRestaurantData] = useState(null)
  const [companyName, setCompanyName] = useState(() => getCompanyName() || "Restaurant")
  const [logoUrl, setLogoUrl] = useState(() => getModuleLogoUrl("restaurant"))
  const [expandedSections, setExpandedSections] = useState(() => {
    // Auto-expand whichever expandable section already contains the active route.
    const initial = {}
    sections.forEach((section) => {
      section.items.forEach((item) => {
        if (item.type === "expandable") {
          const hasActiveSub = item.subItems.some((sub) =>
            isItemActive(sub, window.location.pathname, window.location.search)
          )
          if (hasActiveSub) initial[item.name] = true
        }
      })
    })
    return initial
  })

  const toggleSection = (name) => {
    setExpandedSections((prev) => ({ ...prev, [name]: !prev[name] }))
  }

  // Lenis (and the main layout scroll) steal wheel events — handle them here so
  // mouse/trackpad scrolling works without relying on the scrollbar thumb.
  useEffect(() => {
    const el = navScrollRef.current
    if (!el) return undefined

    const onWheel = (event) => {
      const { scrollTop, scrollHeight, clientHeight } = el
      const canScroll = scrollHeight > clientHeight
      if (!canScroll) return

      const atTop = scrollTop <= 0
      const atBottom = scrollTop + clientHeight >= scrollHeight - 1
      const scrollingUp = event.deltaY < 0
      const scrollingDown = event.deltaY > 0

      if ((scrollingUp && !atTop) || (scrollingDown && !atBottom)) {
        el.scrollTop += event.deltaY
        event.preventDefault()
        event.stopPropagation()
      } else if (canScroll) {
        // Still stop Lenis from hijacking while pointer is over the sidebar
        event.stopPropagation()
      }
    }

    el.addEventListener("wheel", onWheel, { passive: false, capture: true })
    return () => el.removeEventListener("wheel", onWheel, { capture: true })
  }, [])

  useEffect(() => {
    const loadSettings = async () => {
      const cached = getCachedSettings()
      if (cached?.companyName) setCompanyName(cached.companyName)
      const resolvedLogo = getModuleLogoUrl("restaurant")
      if (resolvedLogo) setLogoUrl(resolvedLogo)

      if (!cached) {
        const settings = await loadBusinessSettings()
        if (settings?.companyName) setCompanyName(settings.companyName)
        const logo = getModuleLogoUrl("restaurant")
        if (logo) setLogoUrl(logo)
      }
    }
    loadSettings()

    const onUpdate = () => {
      const cached = getCachedSettings()
      if (cached?.companyName) setCompanyName(cached.companyName)
      const logo = getModuleLogoUrl("restaurant")
      if (logo) setLogoUrl(logo)
    }
    window.addEventListener("businessSettingsUpdated", onUpdate)
    return () => window.removeEventListener("businessSettingsUpdated", onUpdate)
  }, [])

  useEffect(() => {
    const fetchRestaurantData = async () => {
      try {
        const response = await restaurantAPI.getCurrentRestaurant()
        const data = extractRestaurantPayload(response)
        if (data) setRestaurantData(data)
      } catch {
        // Keep defaults if fetch fails
      }
    }
    fetchRestaurantData()
  }, [])

  const restaurantName = restaurantData?.name || companyName || "Restaurant"
  const ownerName =
    restaurantData?.ownerName ||
    restaurantData?.owner?.name ||
    restaurantData?.name ||
    "Owner"
  const ownerImage =
    restaurantData?.profileImage?.url ||
    restaurantData?.ownerImage?.url ||
    restaurantData?.logo?.url ||
    ""

  const onLogout = async () => {
    try {
      await logoutRestaurantSession({ navigate })
    } catch (error) {
      console.error("Logout failed:", error)
      navigate("/seller/login", { replace: true })
    }
  }

  return (
    <aside className="hidden md:flex flex-col w-64 h-screen fixed left-0 top-0 bg-white border-r border-gray-100 shadow-[2px_0_10px_rgba(0,0,0,0.02)] z-50">
      <div className="p-5">
        <div className="flex items-center gap-3">
          {/*
            The bundled mark is the default rather than a green store glyph:
            with no logo uploaded the panel showed a colour that belongs to
            neither the brand nor this module's theme. object-contain, because
            cover crops a mark that carries its own padding.
          */}
          <div className="w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center shrink-0 overflow-hidden">
            <img
              src={logoUrl || brandIcon}
              alt={restaurantName || "6AM Fresh"}
              className="w-full h-full object-contain rounded-xl p-0.5"
              onError={(e) => {
                if (e.target.src !== brandIcon) {
                  e.target.src = brandIcon
                }
              }}
            />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="font-bold text-gray-900 text-sm truncate">{restaurantName}</span>
            <span className="text-xs text-gray-500 truncate">Seller panel</span>
          </div>
        </div>
      </div>

      <div
        ref={navScrollRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 pb-4 space-y-6 custom-scrollbar"
        style={{ overscrollBehavior: "contain" }}
      >
        {sections.map((section) => (
          <div key={section.title}>
            <h3 className="text-[11px] font-bold text-gray-400 mb-2 uppercase tracking-wider px-2">
              {section.title}
            </h3>
            <ul className="space-y-1">
              {section.items.map((item) => {
                if (item.type === "expandable") {
                  const isExpanded = expandedSections[item.name] || false
                  const hasActiveSub = item.subItems.some((sub) =>
                    isItemActive(sub, location.pathname, location.search)
                  )

                  return (
                    <li key={`${section.title}-${item.name}`}>
                      <button
                        type="button"
                        onClick={() => toggleSection(item.name)}
                        className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-all duration-200 ${
                          hasActiveSub
                            ? "bg-green-50 text-green-700"
                            : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <item.icon
                            className={`w-4 h-4 shrink-0 ${hasActiveSub ? "text-green-600" : "text-gray-400"}`}
                          />
                          <span className={`text-sm truncate ${hasActiveSub ? "font-semibold" : "font-medium"}`}>
                            {item.name}
                          </span>
                        </div>
                        <ChevronDown
                          className={`w-4 h-4 shrink-0 text-gray-400 transition-transform duration-200 ${
                            isExpanded ? "rotate-0" : "-rotate-90"
                          }`}
                        />
                      </button>
                      {isExpanded && (
                        <ul className="ml-4 mt-1 space-y-1 pl-3 border-l border-gray-200">
                          {item.subItems.map((sub) => {
                            const isSubActive = isItemActive(sub, location.pathname, location.search)
                            return (
                              <li key={sub.path}>
                                <NavLink
                                  to={sub.path}
                                  className={`flex items-center px-3 py-1.5 rounded-lg text-[13px] transition-all duration-200 ${
                                    isSubActive
                                      ? "bg-green-50 text-green-700 font-semibold"
                                      : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                                  }`}
                                >
                                  {sub.name}
                                </NavLink>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </li>
                  )
                }

                const isActive = isItemActive(item, location.pathname, location.search)

                return (
                  <li key={`${section.title}-${item.name}`}>
                    <NavLink
                      to={item.path}
                      className={`flex items-center justify-between px-3 py-2.5 rounded-xl transition-all duration-200 ${
                        isActive
                          ? "bg-green-50 text-green-700"
                          : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <item.icon
                          className={`w-4 h-4 shrink-0 ${isActive ? "text-green-600" : "text-gray-400"}`}
                        />
                        <span className={`text-sm truncate ${isActive ? "font-semibold" : "font-medium"}`}>
                          {item.name}
                        </span>
                      </div>
                    </NavLink>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}

        <div className="pt-3 border-t border-gray-100">
          <p className="px-1 mb-2 text-[11px] font-bold uppercase tracking-wider text-gray-400">
            More Tools
          </p>
          <div className="grid grid-cols-2 gap-2">
            {MORE_TOOLS.map((tool) => (
              <NavLink
                key={tool.path}
                to={tool.path}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-gray-200 py-2.5 text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
              >
                <tool.icon className="w-4 h-4" />
                <span className="text-[11px] font-medium">{tool.label}</span>
              </NavLink>
            ))}
          </div>
        </div>
      </div>

      <div className="shrink-0 p-4 pt-3 bg-white border-t border-gray-100">
        <button
          type="button"
          onClick={() => navigate(`${BASE}/outlet-info`)}
          className="flex w-full items-center gap-3 rounded-xl bg-gray-50 p-2 mb-3 text-left transition-colors hover:bg-gray-100"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-green-600 text-sm font-bold text-white">
            {ownerImage ? (
              <img src={ownerImage} alt={ownerName} className="h-full w-full object-cover" />
            ) : (
              ownerName.charAt(0).toUpperCase()
            )}
          </div>
          <div className="min-w-0 flex flex-col">
            <span className="truncate text-sm font-semibold text-gray-900">{ownerName}</span>
            <span className="truncate text-xs text-gray-500">My profile</span>
          </div>
        </button>
        <button
          type="button"
          onClick={onLogout}
          className="w-full flex items-center justify-center gap-2 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Logout
        </button>
      </div>
    </aside>
  )
}
