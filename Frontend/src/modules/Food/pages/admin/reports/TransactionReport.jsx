import { useState, useMemo, useEffect } from "react"
import { BarChart3, ChevronDown, Settings, FileText, FileSpreadsheet, Code, Loader2, Calendar, Download } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@food/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@food/components/ui/dialog"
import { exportTransactionReportToCSV, exportTransactionReportToExcel, exportTransactionReportToPDF, exportTransactionReportToJSON } from "@food/components/admin/reports/reportsExportUtils"
import { adminAPI } from "@food/api"
import { toast } from "sonner"

// Import icons from Transaction-report-icons
import completedIcon from "@food/assets/Transaction-report-icons/trx1.png"
import refundedIcon from "@food/assets/Transaction-report-icons/trx3.png"
import adminEarningIcon from "@food/assets/Transaction-report-icons/admin-earning.png"
import restaurantEarningIcon from "@food/assets/Transaction-report-icons/store-earning.png"
import deliverymanEarningIcon from "@food/assets/Transaction-report-icons/deliveryman-earning.png"

// Import search and export icons from Dashboard-icons
import searchIcon from "@food/assets/Dashboard-icons/image8.png"
import exportIcon from "@food/assets/Dashboard-icons/image9.png"
const debugLog = (...args) => {}
const debugWarn = (...args) => {}
const debugError = (...args) => {}

// One source of truth for turning the chosen preset (or custom range) into
// concrete from/to Date objects. Boundaries are built in the admin's LOCAL
// time (midnight → 23:59:59.999 of the local day); the caller serialises with
// toISOString() so the backend gets the exact instant, and the same instant is
// used to render the "showing" label — so what is filtered and what is shown
// can never disagree.
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)

const computeDateRange = (time, fromDateStr, toDateStr) => {
  const now = new Date()
  let from = null
  let to = null

  switch (time) {
    case "Custom Range":
      if (fromDateStr) from = new Date(`${fromDateStr}T00:00:00`)
      if (toDateStr) to = new Date(`${toDateStr}T23:59:59.999`)
      break
    case "Today":
      from = startOfDay(now)
      to = endOfDay(now)
      break
    case "Yesterday": {
      const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      from = startOfDay(y)
      to = endOfDay(y)
      break
    }
    case "This Week": {
      const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay())
      const weekEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() + 6)
      from = startOfDay(weekStart)
      to = endOfDay(weekEnd)
      break
    }
    case "This Month":
      from = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1))
      to = endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0))
      break
    case "This Year":
      from = startOfDay(new Date(now.getFullYear(), 0, 1))
      to = endOfDay(new Date(now.getFullYear(), 11, 31))
      break
    default:
      // All Time — no bounds
      break
  }

  return { from, to }
}

const formatRangeDate = (d) =>
  d ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : ""

export default function TransactionReport() {
  const [searchQuery, setSearchQuery] = useState("")
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [summary, setSummary] = useState({
    completedTransaction: 0,
    refundedTransaction: 0,
    adminEarning: 0,
    restaurantEarning: 0,
    deliverymanEarning: 0
  })
  const [filters, setFilters] = useState({
    zone: "All Zones",
    restaurant: "All restaurants",
    time: "All Time",
    fromDate: "",
    toDate: "",
  })
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [zones, setZones] = useState([])
  const [restaurants, setRestaurants] = useState([])

  // Fetch zones and restaurants for filters
  useEffect(() => {
    const fetchFilterData = async () => {
      try {
        // Fetch zones
        const zonesResponse = await adminAPI.getZones({ limit: 1000 })
        if (zonesResponse?.data?.success && zonesResponse.data.data?.zones) {
          setZones(zonesResponse.data.data.zones)
        }

        // Fetch restaurants
        const restaurantsResponse = await adminAPI.getRestaurants({ limit: 1000 })
        if (restaurantsResponse?.data?.success && restaurantsResponse.data.data?.restaurants) {
          setRestaurants(restaurantsResponse.data.data.restaurants)
        }
      } catch (error) {
        debugError("Error fetching filter data:", error)
      }
    }
    fetchFilterData()
  }, [])

  // Fetch transaction report data
  useEffect(() => {
    const fetchTransactionReport = async () => {
      try {
        setIsRefreshing(true)

        // Build date range from the chosen preset / custom range (shared helper).
        const { from: fromDate, to: toDate } = computeDateRange(filters.time, filters.fromDate, filters.toDate)

        const params = {
          search: searchQuery || undefined,
          zone: filters.zone !== "All Zones" ? filters.zone : undefined,
          restaurant: filters.restaurant !== "All restaurants" ? filters.restaurant : undefined,
          fromDate: fromDate ? fromDate.toISOString() : undefined,
          toDate: toDate ? toDate.toISOString() : undefined,
          limit: 1000
        }

        const response = await adminAPI.getTransactionReport(params)

        if (response?.data?.success && response.data.data) {
          setTransactions(response.data.data.transactions || [])
          setSummary(response.data.data.summary || {
            completedTransaction: 0,
            refundedTransaction: 0,
            adminEarning: 0,
            restaurantEarning: 0,
            deliverymanEarning: 0
          })
        } else {
          setTransactions([])
          if (response?.data?.message) {
            toast.error(response.data.message)
          }
        }
      } catch (error) {
        debugError("Error fetching transaction report:", error)
        toast.error("Failed to fetch transaction report")
        setTransactions([])
      } finally {
        setIsRefreshing(false)
        setLoading(false)
      }
    }

    fetchTransactionReport()
  }, [searchQuery, filters])

  const filteredTransactions = useMemo(() => {
    return transactions // Backend already filters, so just return transactions
  }, [transactions])

  const handleExport = (format) => {
    if (filteredTransactions.length === 0) {
      alert("No data to export")
      return
    }
    switch (format) {
      case "csv": exportTransactionReportToCSV(filteredTransactions); break
      case "excel": exportTransactionReportToExcel(filteredTransactions); break
      case "pdf": exportTransactionReportToPDF(filteredTransactions); break
      case "json": exportTransactionReportToJSON(filteredTransactions); break
    }
  }

  // Download the report for a single order's transaction row.
  const handleDownloadTransaction = (transaction, format) => {
    if (!transaction) return
    const safeId = String(transaction.orderId || transaction.id || "order").replace(/[^a-zA-Z0-9_-]/g, "_")
    const filename = `transaction_${safeId}`
    switch (format) {
      case "csv": exportTransactionReportToCSV([transaction], filename); break
      case "excel": exportTransactionReportToExcel([transaction], filename); break
      case "pdf": exportTransactionReportToPDF([transaction], filename); break
      case "json": exportTransactionReportToJSON([transaction], filename); break
      default: return
    }
    toast.success(`Downloaded transaction ${transaction.orderId || ""}`.trim())
  }

  const handleFilterApply = () => {
    // Filters are already applied via useMemo
  }

  const handleResetFilters = () => {
    setFilters({
      zone: "All Zones",
      restaurant: "All restaurants",
      time: "All Time",
      fromDate: "",
      toDate: "",
    })
  }

  const activeFiltersCount = (filters.zone !== "All Zones" ? 1 : 0) + (filters.restaurant !== "All restaurants" ? 1 : 0) + (filters.time !== "All Time" ? 1 : 0)

  // The exact range being applied, and readable names, for the "showing" line.
  const appliedRange = useMemo(
    () => computeDateRange(filters.time, filters.fromDate, filters.toDate),
    [filters.time, filters.fromDate, filters.toDate],
  )
  const dateRangeText = appliedRange.from && appliedRange.to
    ? `${formatRangeDate(appliedRange.from)} – ${formatRangeDate(appliedRange.to)}`
    : filters.time === "All Time"
      ? "All Time"
      : filters.time
  const selectedZoneName = useMemo(() => {
    if (filters.zone === "All Zones") return "All Zones"
    const z = zones.find((zz) => String(zz._id) === String(filters.zone))
    return z?.zoneName || z?.name || "Selected zone"
  }, [filters.zone, zones])
  const selectedRestaurantName = useMemo(() => {
    if (filters.restaurant === "All restaurants") return "All restaurants"
    const r = restaurants.find((rr) => String(rr._id) === String(filters.restaurant))
    return r?.restaurantName || r?.name || "Selected restaurant"
  }, [filters.restaurant, restaurants])

  const formatCurrency = (amount) => {
    if (amount >= 1000) {
      return `\u20B9 ${(amount / 1000).toFixed(2)}K`
    }
    return `\u20B9 ${amount.toFixed(2)}`
  }

  const formatFullCurrency = (amount) => {
    return `\u20B9 ${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const getStatusBadgeClasses = (status) => {
    const normalized = String(status || '').toLowerCase()

    if (['captured', 'settled', 'completed', 'paid', 'delivered'].includes(normalized)) {
      return 'bg-green-100 text-green-700'
    }
    if (['pending', 'created', 'authorized', 'cod_pending'].includes(normalized)) {
      return 'bg-yellow-100 text-yellow-700'
    }
    if (['failed', 'refunded', 'cancelled', 'cancelled_by_admin', 'cancelled_by_user', 'cancelled_by_restaurant'].includes(normalized)) {
      return 'bg-red-100 text-red-700'
    }

    return 'bg-slate-100 text-slate-700'
  }

  if (loading) {
    return (
      <div className="p-2 lg:p-3 bg-slate-50 min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
          <p className="text-gray-600">Loading transaction report...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-2 lg:p-3 bg-slate-50 min-h-screen">
      <div className="w-full mx-auto">
        {/* Page Header */}
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-3 mb-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center">
              <BarChart3 className="w-3.5 h-3.5 text-white" />
            </div>
            <h1 className="text-lg font-bold text-slate-900">Transaction Report</h1>
          </div>
        </div>

        {/* Search Data Section */}
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-3 mb-3">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <select
                value={filters.zone}
                onChange={(e) => setFilters(prev => ({ ...prev, zone: e.target.value }))}
                className="w-full px-2.5 py-1.5 pr-5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs appearance-none cursor-pointer"
              >
                <option value="All Zones">All Zones</option>
                {zones.map(zone => (
                  <option key={zone._id} value={zone._id}>{zone.zoneName || zone.name}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500 pointer-events-none" />
            </div>

            <div className="relative flex-1 min-w-0">
              <select
                value={filters.restaurant}
                onChange={(e) => setFilters(prev => ({ ...prev, restaurant: e.target.value }))}
                className="w-full px-2.5 py-1.5 pr-5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs appearance-none cursor-pointer"
              >
                <option value="All restaurants">All restaurants</option>
                {restaurants.map(restaurant => (
                  <option key={restaurant._id} value={restaurant._id}>{restaurant.restaurantName || restaurant.name}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500 pointer-events-none" />
            </div>

            <div className="relative flex-1 min-w-0">
              <select
                value={filters.time}
                onChange={(e) => setFilters(prev => ({
                  ...prev,
                  time: e.target.value,
                  ...(e.target.value !== "Custom Range" ? { fromDate: "", toDate: "" } : {}),
                }))}
                className="w-full px-2.5 py-1.5 pr-5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs appearance-none cursor-pointer"
              >
                <option value="All Time">All Time</option>
                <option value="Today">Today</option>
                <option value="Yesterday">Yesterday</option>
                <option value="This Week">This Week</option>
                <option value="This Month">This Month</option>
                <option value="This Year">This Year</option>
                <option value="Custom Range">Custom Range</option>
              </select>
              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500 pointer-events-none" />
            </div>

            <button 
              onClick={handleFilterApply}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-all whitespace-nowrap relative ${
                activeFiltersCount > 0 ? "ring-2 ring-blue-300" : ""
              }`}
            >
              Filter
              {activeFiltersCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-500 text-white rounded-full text-[8px] flex items-center justify-center font-bold">
                  {activeFiltersCount}
                </span>
              )}
            </button>
            <button 
              onClick={handleResetFilters}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 transition-all whitespace-nowrap"
            >
              Reset
            </button>
          </div>

          {filters.time === "Custom Range" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
              <div className="relative">
                <Calendar className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                <input
                  type="date"
                  value={filters.fromDate}
                  onChange={(e) => setFilters(prev => ({ ...prev, fromDate: e.target.value }))}
                  className="w-full pl-8 pr-2.5 py-1.5 text-xs rounded-lg border border-slate-300 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="From Date"
                />
              </div>
              <div className="relative">
                <Calendar className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                <input
                  type="date"
                  value={filters.toDate}
                  onChange={(e) => setFilters(prev => ({ ...prev, toDate: e.target.value }))}
                  className="w-full pl-8 pr-2.5 py-1.5 text-xs rounded-lg border border-slate-300 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="To Date"
                />
              </div>
            </div>
          )}

          {/* Clearly show which date range and zone are currently applied. */}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600">
            <span className="inline-flex items-center gap-1">
              <Calendar className="w-3 h-3 text-blue-500" />
              <span className="font-semibold text-slate-700">Date:</span> {dateRangeText}
            </span>
            <span className="text-slate-300">•</span>
            <span><span className="font-semibold text-slate-700">Zone:</span> {selectedZoneName}</span>
            {filters.restaurant !== "All restaurants" && (
              <>
                <span className="text-slate-300">•</span>
                <span><span className="font-semibold text-slate-700">Restaurant:</span> {selectedRestaurantName}</span>
              </>
            )}
            {activeFiltersCount > 0 && (
              <button type="button" onClick={handleResetFilters} className="ml-auto font-medium text-blue-600 hover:underline">
                Reset filters
              </button>
            )}
          </div>
        </div>

        {/* Summary Cards — one uniform, responsive row of stat tiles */}
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 mb-3">
          {[
            { icon: completedIcon, label: "Completed Transaction", value: summary.completedTransaction, iconBg: "bg-green-100", valueColor: "text-green-600" },
            { icon: refundedIcon, label: "Refunded Transaction", value: summary.refundedTransaction, iconBg: "bg-red-100", valueColor: "text-red-600" },
            { icon: adminEarningIcon, label: "Admin Earning", value: summary.adminEarning, iconBg: "bg-emerald-100", valueColor: "text-slate-900" },
            { icon: restaurantEarningIcon, label: "Restaurant Earning", value: summary.restaurantEarning, iconBg: "bg-blue-100", valueColor: "text-green-600" },
            { icon: deliverymanEarningIcon, label: "Deliveryman Earning", value: summary.deliverymanEarning, iconBg: "bg-orange-100", valueColor: "text-orange-600" },
          ].map((card) => (
            <div
              key={card.label}
              className="rounded-lg shadow-sm border border-slate-200 bg-white p-4 flex flex-col items-center justify-center text-center h-full"
            >
              <div className={`w-12 h-12 rounded-full ${card.iconBg} flex items-center justify-center mb-2`}>
                <img src={card.icon} alt={card.label} className="w-8 h-8 object-contain" />
              </div>
              <p className={`text-lg font-bold ${card.valueColor}`}>{formatCurrency(card.value)}</p>
              <p className="text-xs text-slate-600 mt-0.5 leading-tight">{card.label}</p>
            </div>
          ))}
        </div>

        {/* Order Transactions Section */}
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
            <h2 className="text-base font-bold text-slate-900">Order Transactions {filteredTransactions.length}</h2>

            <div className="flex items-center gap-2">
              <div className="relative flex-1 sm:flex-initial min-w-[180px]">
                <input
                  type="text"
                  placeholder="Search by Order ID"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-7 pr-2 py-1.5 w-full text-[11px] rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <img src={searchIcon} alt="Search" className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3" />
                {isRefreshing && (
                  <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 animate-spin" />
                )}
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1 transition-all">
                    <img src={exportIcon} alt="Export" className="w-3 h-3" />
                    <span>Export</span>
                    <ChevronDown className="w-2.5 h-2.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 bg-white border border-slate-200 rounded-lg shadow-lg z-50 animate-in fade-in-0 zoom-in-95 duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95">
                  <DropdownMenuLabel>Export Format</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => handleExport("csv")} className="cursor-pointer">
                    <FileText className="w-4 h-4 mr-2" />
                    Export as CSV
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport("excel")} className="cursor-pointer">
                    <FileSpreadsheet className="w-4 h-4 mr-2" />
                    Export as Excel
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport("pdf")} className="cursor-pointer">
                    <FileText className="w-4 h-4 mr-2" />
                    Export as PDF
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport("json")} className="cursor-pointer">
                    <Code className="w-4 h-4 mr-2" />
                    Export as JSON
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <button 
                onClick={() => setIsSettingsOpen(true)}
                className="p-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 transition-all"
              >
                <Settings className="w-3 h-3" />
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto scrollbar-hide">
            <table className="w-full" style={{ tableLayout: 'fixed', width: '100%' }}>
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '3%' }}>SI</th>
                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '7%' }}>Order Id</th>
                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '10%' }}>Restaurant</th>
                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '10%' }}>Customer Name</th>
                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '11%' }}>Total Item Amount</th>
                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '9%' }}>Coupon Discount</th>
                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '9%' }}>Vat/Tax</th>
                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '10%' }}>Delivery Charge</th>
                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '9%' }}>Platform Fee</th>
                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '9%' }}>Order Amount</th>
                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '7%' }}>Status</th>
                  <th className="px-1.5 py-1 text-center text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '6%' }}>Action</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-100">
                {filteredTransactions.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-6 py-20 text-center">
                      <div className="flex flex-col items-center justify-center">
                        <p className="text-lg font-semibold text-slate-700 mb-1">No Data Found</p>
                        <p className="text-sm text-slate-500">No transactions match your search</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredTransactions.map((transaction, index) => (
                    <tr
                      key={transaction.id}
                      className="hover:bg-slate-50 transition-colors"
                    >
                      <td className="px-1.5 py-1">
                        <span className="text-[10px] font-medium text-slate-700">{index + 1}</span>
                      </td>
                      <td className="px-1.5 py-1">
                        <span className="text-[10px] text-slate-700">{transaction.orderId}</span>
                      </td>
                      <td className="px-1.5 py-1">
                        <span className="text-[10px] text-slate-700 truncate block">{transaction.restaurant}</span>
                      </td>
                      <td className="px-1.5 py-1">
                        <span className={`text-[10px] truncate block ${
                          transaction.customerName === "Invalid Customer Data" 
                            ? "text-red-600 font-semibold" 
                            : "text-slate-700"
                        }`}>
                          {transaction.customerName}
                        </span>
                      </td>
                      <td className="px-1.5 py-1">
                        <span className="text-[10px] text-slate-700">{formatFullCurrency(transaction.totalItemAmount)}</span>
                      </td>
                      <td className="px-1.5 py-1">
                        <span className="text-[10px] text-slate-700">{formatFullCurrency(transaction.couponDiscount)}</span>
                      </td>
                      <td className="px-1.5 py-1">
                        <span className="text-[10px] text-slate-700">{formatFullCurrency(transaction.vatTax)}</span>
                      </td>
                      <td className="px-1.5 py-1">
                        <span className="text-[10px] text-slate-700">{formatFullCurrency(transaction.deliveryCharge)}</span>
                      </td>
                      <td className="px-1.5 py-1">
                        <span className="text-[10px] text-slate-700">{formatFullCurrency(transaction.platformFee || 0)}</span>
                      </td>
                      <td className="px-1.5 py-1">
                        <span className="text-[10px] font-medium text-slate-900">{formatFullCurrency(transaction.orderAmount)}</span>
                      </td>
                      <td className="px-1.5 py-1">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${getStatusBadgeClasses(transaction.status || transaction.orderStatus)}`}>
                          {transaction.status || transaction.orderStatus || 'N/A'}
                        </span>
                      </td>
                      <td className="px-1.5 py-1 text-center">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              title="Download this order's transaction"
                              className="inline-flex items-center justify-center gap-0.5 rounded-md bg-blue-50 px-1.5 py-1 text-blue-600 hover:bg-blue-100 transition-colors"
                            >
                              <Download className="w-3 h-3" />
                              <ChevronDown className="w-2 h-2" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44 bg-white border border-slate-200 rounded-lg shadow-lg z-50">
                            <DropdownMenuLabel>Download Order</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => handleDownloadTransaction(transaction, "pdf")} className="cursor-pointer">
                              <FileText className="w-4 h-4 mr-2" /> PDF
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleDownloadTransaction(transaction, "excel")} className="cursor-pointer">
                              <FileSpreadsheet className="w-4 h-4 mr-2" /> Excel
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleDownloadTransaction(transaction, "csv")} className="cursor-pointer">
                              <FileText className="w-4 h-4 mr-2" /> CSV
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleDownloadTransaction(transaction, "json")} className="cursor-pointer">
                              <Code className="w-4 h-4 mr-2" /> JSON
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Settings Dialog */}
      <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
        <DialogContent className="max-w-md bg-white p-0 opacity-0 data-[state=open]:opacity-100 data-[state=closed]:opacity-0 transition-opacity duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:scale-100 data-[state=closed]:scale-100">
          <DialogHeader className="px-6 pt-6 pb-4">
            <DialogTitle className="flex items-center gap-2">
              <Settings className="w-5 h-5" />
              Report Settings
            </DialogTitle>
          </DialogHeader>
          <div className="px-6 pb-6">
            <p className="text-sm text-slate-700">
              Transaction report settings and preferences will be available here.
            </p>
          </div>
          <div className="px-6 pb-6 flex items-center justify-end">
            <button
              onClick={() => setIsSettingsOpen(false)}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition-all shadow-md"
            >
              Close
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
