import { useNavigate } from "react-router-dom"
import { cn } from "@food/utils/utils"

const TABS = [
  { key: "all", label: "All", path: "/admin/store/orders/all" },
  { key: "scheduled", label: "Scheduled", path: "/admin/store/orders/scheduled" },
  { key: "pending", label: "Pending", path: "/admin/store/orders/pending" },
  { key: "processing", label: "Processing", path: "/admin/store/orders/processing" },
  { key: "food-on-the-way", label: "Out For Delivery", path: "/admin/store/orders/food-on-the-way" },
  { key: "delivered", label: "Delivered", path: "/admin/store/orders/delivered" },
  { key: "canceled", label: "Cancelled", path: "/admin/store/orders/canceled" },
  { key: "restaurant-cancelled", label: "Seller cancelled", path: "/admin/store/orders/restaurant-cancelled" },
  { key: "payment-failed", label: "Payment Failed", path: "/admin/store/orders/payment-failed" },
  { key: "refunded", label: "Refunded", path: "/admin/store/orders/refunded" },
  { key: "offline-payments", label: "Offline Payments", path: "/admin/store/orders/offline-payments" },
  { key: "abandoned", label: "Abandoned", path: "/admin/store/orders/abandoned" },
  { key: "user-carts", label: "User Carts", path: "/admin/store/orders/user-carts" },
]

/** Quick status switcher shown at the top of every Orders page — jump between
 * statuses without going back to the sidebar, mirroring how the orders list
 * itself is a single view with tabs rather than a dozen separate pages. */
export default function OrderStatusTabs({ activeStatus }) {
  const navigate = useNavigate()

  return (
    <div className="flex flex-wrap gap-2 mb-4">
      {TABS.map((tab) => {
        const isActive = tab.key === activeStatus
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => navigate(tab.path)}
            className={cn(
              "px-4 py-2 rounded-full text-sm font-semibold transition-colors whitespace-nowrap",
              isActive
                ? "bg-[#FA0272] text-white"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            )}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
