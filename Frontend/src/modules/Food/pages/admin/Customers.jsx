import { useState, useEffect } from "react"
import { useSearchParams } from "react-router-dom"
import { Search, Download, ChevronDown, ChevronLeft, ChevronRight, Calendar, Eye, FileDown, FileSpreadsheet, FileText, X, Mail, Phone, MapPin, Package, IndianRupee, Calendar as CalendarIcon, User, CheckCircle, XCircle, Wallet } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@food/components/ui/dropdown-menu"
import { exportCustomersToCSV, exportCustomersToExcel, exportCustomersToPDF } from "@food/components/admin/customers/customersExportUtils"
import { adminAPI } from "@food/api"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@food/components/ui/dialog"
const debugLog = (...args) => {}
const debugWarn = (...args) => {}
const debugError = (...args) => {}

const PAGE_SIZE = 20

export default function Customers() {
  const [searchQuery, setSearchQuery] = useState("")
  const [searchInput, setSearchInput] = useState("")
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [totalCustomers, setTotalCustomers] = useState(0)
  const [page, setPage] = useState(1)
  const [selectedCustomer, setSelectedCustomer] = useState(null)
  const [userDetails, setUserDetails] = useState(null)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [showUserDetails, setShowUserDetails] = useState(false)
  // Purely a display filter: the wallet's own per-row balance already reflects
  // the true account history, so narrowing which rows are visible never
  // recomputes it -- a filtered statement still has to show the real balance
  // the account actually had at each shown entry, not a total re-derived from
  // only what happens to be on screen.
  const [walletFilters, setWalletFilters] = useState({ type: "all", from: "", to: "" })
  const [filters, setFilters] = useState({
    orderDate: "",
    joiningDate: "",
    status: "",
    sortBy: "",
    chooseFirst: "",
  })

  const totalPages = Math.max(1, Math.ceil(totalCustomers / PAGE_SIZE))
  const showingFrom = totalCustomers === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const showingTo = Math.min(page * PAGE_SIZE, totalCustomers)

  useEffect(() => {
    if (!loading && page > totalPages) {
      setPage(totalPages)
    }
  }, [loading, page, totalPages])

  const handleFilterChange = (field, value) => {
    setPage(1)
    setFilters(prev => ({ ...prev, [field]: value }))
  }

  const handleSearch = () => {
    setPage(1)
    setSearchQuery(searchInput.trim())
  }

  const formatDateTime = (value) => {
    if (!value) return "-"
    try {
      const d = new Date(value)
      if (Number.isNaN(d.getTime())) return String(value)
      const day = String(d.getDate()).padStart(2, "0")
      const month = d.toLocaleString("en-GB", { month: "short" })
      const year = d.getFullYear()
      const time = d.toLocaleString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
      return `${day} ${month} ${year}, ${time}`
    } catch {
      return String(value)
    }
  }

  // Fetch customers from API
  useEffect(() => {
    let cancelled = false
    const fetchCustomers = async () => {
      try {
        setLoading(true)
        const chooseFirst = parseInt(filters.chooseFirst, 10)
        const useChooseFirst = Number.isFinite(chooseFirst) && chooseFirst > 0
        const params = {
          limit: useChooseFirst ? chooseFirst : PAGE_SIZE,
          page: useChooseFirst ? 1 : page,
          ...(searchQuery && { search: searchQuery }),
          ...(filters.status && { status: filters.status }),
          ...(filters.joiningDate && { joiningDate: filters.joiningDate }),
          ...(filters.sortBy && { sortBy: filters.sortBy }),
          ...(useChooseFirst && { chooseFirst }),
        }

        const response = await adminAPI.getCustomers(params)
        const data = response?.data?.data || response?.data

        const list = data?.customers || data?.users || []
        if (!cancelled && Array.isArray(list)) {
          setCustomers(list)
          setTotalCustomers(Number(data?.total) || list.length)
        } else if (!cancelled) {
          setCustomers([])
          setTotalCustomers(0)
        }
      } catch (error) {
        debugError('Error fetching customers:', error)
        toast.error('Failed to load customers')
        if (!cancelled) {
          setCustomers([])
          setTotalCustomers(0)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    const t = setTimeout(fetchCustomers, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [page, searchQuery, filters.status, filters.joiningDate, filters.sortBy, filters.chooseFirst])

  const [searchParams] = useSearchParams()
  const userIdFromUrl = searchParams.get("userId")

  useEffect(() => {
    if (userIdFromUrl) {
      handleViewDetails(userIdFromUrl)
    }
  }, [userIdFromUrl])

  const handleToggleStatus = async (customerId) => {
    try {
      // Find customer
      const customer = customers.find(c => (c._id || c.id) === customerId)
      if (!customer) return

      const newStatus = !customer.status

      // Optimistically update UI
      setCustomers(customers.map(c =>
        c.id === customerId ? { ...c, status: newStatus } : c
      ))

      // Call API to update user status
      await adminAPI.updateCustomerStatus(customerId, newStatus)
      toast.success(`User ${newStatus ? 'activated' : 'deactivated'} successfully`)
    } catch (error) {
      debugError('Error updating status:', error)
      toast.error('Failed to update status')
      // Revert optimistic update
      setCustomers(customers.map(c =>
        c.id === customerId ? { ...c, status: !c.status } : c
      ))
    }
  }

  const handleViewDetails = async (customerId) => {
    try {
      setLoadingDetails(true)
      setShowUserDetails(true)
      setSelectedCustomer(customerId)
      // A filter left on from the last customer's statement must not silently
      // hide rows on this one.
      setWalletFilters({ type: "all", from: "", to: "" })

      const response = await adminAPI.getCustomerById(customerId)
      const data = response?.data?.data || response?.data

      if (data?.user) {
        setUserDetails(data.user)
      } else {
        toast.error('Failed to load user details')
        setShowUserDetails(false)
      }
    } catch (error) {
      debugError('Error fetching user details:', error)
      toast.error('Failed to load user details')
      setShowUserDetails(false)
    } finally {
      setLoadingDetails(false)
    }
  }

  /**
   * A downloadable statement for one customer's wallet, mirroring the order
   * invoice PDF's own house style (teal header bar, jsPDF + autoTable) so
   * anything printed out of this panel looks like it came from the same
   * place. Debit/credit/running-balance columns, and an opening balance line
   * -- the thing that makes this a statement rather than a transaction list.
   */
  const downloadWalletStatement = async (customer, filteredTransactions) => {
    const transactions = filteredTransactions || customer.walletTransactions || []
    try {
      const { default: jsPDF } = await import("jspdf")
      const { default: autoTable } = await import("jspdf-autotable")

      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" })
      const pageWidth = doc.internal.pageSize.getWidth()

      doc.setFillColor(15, 118, 110)
      doc.rect(0, 0, pageWidth, 32, "F")
      doc.setTextColor(255, 255, 255)
      doc.setFontSize(15)
      doc.setFont(undefined, "bold")
      doc.text("6AM Fresh", 14, 14)
      doc.setFontSize(10)
      doc.setFont(undefined, "normal")
      doc.text("Wallet Statement", 14, 21)
      doc.setFontSize(8.5)
      doc.text(`${customer.name || "Customer"} · ${customer.phone || ""}`, 14, 27)

      autoTable(doc, {
        startY: 40,
        body: [[
          `Opening Balance: ${formatMoney(customer.walletOpeningBalance)}`,
          `Closing Balance: ${formatMoney(customer.walletBalance)}`,
          `Referral Earnings: ${formatMoney(customer.walletReferralEarnings)}`,
        ]],
        theme: "plain",
        styles: {
          fontSize: 9,
          textColor: [30, 41, 59],
          fillColor: [241, 245, 249],
          cellPadding: { top: 3.5, right: 4, bottom: 3.5, left: 4 },
          lineColor: [226, 232, 240],
          lineWidth: 0.25,
          fontStyle: "bold",
        },
        columnStyles: {
          0: { cellWidth: 62 },
          1: { cellWidth: 62, textColor: [15, 118, 110] },
          2: { cellWidth: 62 },
        },
        margin: { left: 14, right: 14 },
      })

      const rows = transactions.length > 0
        ? transactions.map((tx) => [
            formatDateTime(tx.date),
            tx.description || tx.type,
            tx.type === "deduction" ? formatMoney(tx.amount) : "-",
            tx.type !== "deduction" ? formatMoney(tx.amount) : "-",
            formatMoney(tx.balanceAfter),
          ])
        : [["-", "No wallet transactions on record", "-", "-", formatMoney(customer.walletBalance)]]

      autoTable(doc, {
        startY: (doc.lastAutoTable?.finalY || 55) + 6,
        head: [["Date", "Description", "Debit", "Credit", "Balance"]],
        body: rows,
        theme: "grid",
        headStyles: { fillColor: [15, 118, 110], textColor: 255, fontSize: 9, fontStyle: "bold" },
        bodyStyles: { fontSize: 8.5, textColor: [30, 41, 59] },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        styles: { cellPadding: 2.6, lineColor: [226, 232, 240], lineWidth: 0.3 },
        columnStyles: {
          0: { cellWidth: 34 },
          1: { cellWidth: 62 },
          2: { halign: "right", cellWidth: 30, textColor: [190, 18, 60] },
          3: { halign: "right", cellWidth: 30, textColor: [4, 120, 87] },
          4: { halign: "right", cellWidth: 26, fontStyle: "bold" },
        },
        margin: { left: 14, right: 14 },
      })

      const footerY = Math.max((doc.lastAutoTable?.finalY || 100) + 14, 270)
      doc.setDrawColor(226, 232, 240)
      doc.line(14, footerY - 6, pageWidth - 14, footerY - 6)
      doc.setFontSize(8.5)
      doc.setTextColor(100, 116, 139)
      doc.text(`Generated on ${new Date().toLocaleString()}`, 14, footerY)

      const safeName = String(customer.name || "customer").replace(/[^a-z0-9]+/gi, "_")
      doc.save(`Wallet_Statement_${safeName}_${new Date().toISOString().split("T")[0]}.pdf`)
    } catch (error) {
      debugError("Error generating wallet statement PDF:", error)
      toast.error("Failed to download wallet statement. Please try again.")
    }
  }

  const handleExport = (format) => {
    if (customers.length === 0) {
      toast.error("No customers to export")
      return
    }

    const filename = "customers"
    try {
      switch (format) {
        case "csv":
          exportCustomersToCSV(customers, filename)
          toast.success("CSV export started")
          break
        case "excel":
          exportCustomersToExcel(customers, filename)
          toast.success("Excel export started")
          break
        case "pdf":
          exportCustomersToPDF(customers, filename)
          toast.success("PDF download started")
          break
        default:
          toast.error("Invalid export format")
          break
      }
    } catch (error) {
      debugError("Export error:", error)
      toast.error("Failed to export customers")
    }
  }

  const formatMoney = (value) =>
    `Rs. ${(Number(value) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  const getInitials = (name) => {
    if (!name) return "NA"
    return name
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "NA"
  }

  /**
   * Which statement rows the current type/date filters keep.
   *
   * Filters narrow what is shown, not what happened: a row's Balance column
   * still comes straight from the server's own running-balance walk over the
   * *complete* history, so a "Credit only" view does not quietly claim the
   * account never had the debits in between.
   */
  const getFilteredWalletTransactions = () => {
    const all = userDetails?.walletTransactions || []
    const fromTime = walletFilters.from ? new Date(`${walletFilters.from}T00:00:00`).getTime() : null
    const toTime = walletFilters.to ? new Date(`${walletFilters.to}T23:59:59.999`).getTime() : null

    return all.filter((tx) => {
      if (walletFilters.type === "credit" && tx.type === "deduction") return false
      if (walletFilters.type === "debit" && tx.type !== "deduction") return false
      const t = tx.date ? new Date(tx.date).getTime() : null
      if (fromTime !== null && (t === null || t < fromTime)) return false
      if (toTime !== null && (t === null || t > toTime)) return false
      return true
    })
  }

  const walletFiltersActive =
    walletFilters.type !== "all" || Boolean(walletFilters.from) || Boolean(walletFilters.to)

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto">
        {/* Filters Section */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">
                Order Date
              </label>
              <div className="relative">
                <input
                  type="date"
                  max={new Date().toISOString().split("T")[0]}
                  value={filters.orderDate}
                  onChange={(e) => handleFilterChange("orderDate", e.target.value)}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">
                Customer Joining Date
              </label>
              <div className="relative">
                <input
                  type="date"
                  max={new Date().toISOString().split("T")[0]}
                  value={filters.joiningDate}
                  onChange={(e) => handleFilterChange("joiningDate", e.target.value)}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">
                Customer status
              </label>
              <select
                value={filters.status}
                onChange={(e) => handleFilterChange("status", e.target.value)}
                className="w-full px-4 py-2.5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              >
                <option value="">Select Status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">
                Sort By
              </label>
              <select
                value={filters.sortBy}
                onChange={(e) => handleFilterChange("sortBy", e.target.value)}
                className="w-full px-4 py-2.5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              >
                <option value="">Select Customer Sorting Order</option>
                <option value="name-asc">Name (A-Z)</option>
                <option value="name-desc">Name (Z-A)</option>
                <option value="orders-asc">Orders (Low to High)</option>
                <option value="orders-desc">Orders (High to Low)</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">
                Choose First
              </label>
              <input
                type="number"
                value={filters.chooseFirst}
                onChange={(e) => handleFilterChange("chooseFirst", e.target.value)}
                placeholder="Ex: 100"
                className="w-full px-4 py-2.5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              />
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleSearch}
                className="px-6 py-2.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-all"
              >
                Apply Filters
              </button>
              <button
                type="button"
                onClick={() => {
                  setPage(1)
                  setSearchInput("")
                  setSearchQuery("")
                  setFilters({
                    orderDate: "",
                    joiningDate: "",
                    status: "",
                    sortBy: "",
                    chooseFirst: "",
                  })
                }}
                className="px-6 py-2.5 text-sm font-medium rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 transition-all"
              >
                Reset Filters
              </button>
            </div>
            <div className="text-sm text-slate-600">
              {loading
                ? "Loading..."
                : `Showing ${showingFrom}-${showingTo} of ${totalCustomers} customers`}
            </div>
          </div>
        </div>

        {/* Customer List Section */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-slate-900">Customer list</h2>
              <span className="px-3 py-1 rounded-full text-sm font-semibold bg-slate-100 text-slate-700">
                {totalCustomers}
              </span>
            </div>

            <div className="flex items-center gap-3">
              <div className="relative flex-1 sm:flex-initial min-w-[200px]">
                <input
                  type="text"
                  placeholder="Ex: Search by name, email, or phone"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  className="pl-10 pr-4 py-2.5 w-full text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-slate-400"
                />
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="px-4 py-2.5 text-sm font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 flex items-center gap-2 transition-all">
                    <Download className="w-4 h-4" />
                    <span className="text-black font-bold">Export</span>
                    <ChevronDown className="w-3 h-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 bg-white border border-slate-200 rounded-lg shadow-lg z-50">
                  <DropdownMenuLabel>Export Format</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => handleExport("csv")} className="cursor-pointer">
                    <FileDown className="w-4 h-4 mr-2" />
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
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px]">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Sl</th>
                  <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Name</th>
                  <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Contact Information</th>
                  <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Total Order</th>
                  <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Total Order Amount</th>
                  <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Wallet</th>
                  <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Joining Date</th>
                  <th className="px-6 py-4 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider">Active/Inactive</th>
                  <th className="px-6 py-4 text-center text-[10px] font-bold text-slate-700 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-100">
                {loading ? (
                  <tr>
                    <td colSpan={9} className="px-6 py-8 text-center">
                      <div className="text-sm text-slate-500">Loading customers...</div>
                    </td>
                  </tr>
                ) : customers.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-6 py-8 text-center">
                      <div className="text-sm text-slate-500">No customers found</div>
                    </td>
                  </tr>
                ) : (
                  customers.map((customer, index) => (
                    <tr key={customer.id || customer._id || customer.sl} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="text-sm font-medium text-slate-700">
                          {(page - 1) * PAGE_SIZE + index + 1}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div 
                            className="w-10 h-10 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center shrink-0 overflow-hidden cursor-pointer hover:opacity-80 transition-all border border-slate-100"
                            onClick={() => handleViewDetails(customer._id || customer.id || customer.sl)}
                          >
                            {customer.profileImage ? (
                              <img
                                src={customer.profileImage}
                                alt={customer.name}
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  e.currentTarget.style.display = "none"
                                }}
                              />
                            ) : (
                              <span className="text-xs font-semibold">{getInitials(customer.name)}</span>
                            )}
                          </div>
                          <span 
                            className="text-sm font-medium text-slate-900 cursor-pointer hover:text-blue-600 transition-colors"
                            onClick={() => handleViewDetails(customer._id || customer.id || customer.sl)}
                          >
                            {customer.name}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className="text-sm text-slate-700">{customer.email}</span>
                          <span className="text-xs text-slate-500">{customer.phone}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="text-sm text-slate-700">{customer.totalOrder || 0}</span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="text-sm font-medium text-slate-900">Rs. {(customer.totalOrderAmount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`text-sm font-medium ${customer.walletBalance > 0 ? "text-emerald-700" : "text-slate-500"}`}>
                          Rs. {(customer.walletBalance || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="text-sm text-slate-700">{formatDateTime(customer.joiningDate)}</span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <button
                          onClick={() => handleToggleStatus(customer.id || customer.sl)}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${customer.status ? "bg-blue-600" : "bg-slate-300"
                            }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${customer.status ? "translate-x-6" : "translate-x-1"
                              }`}
                          />
                        </button>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        <button
                          onClick={() => handleViewDetails(customer._id || customer.id || customer.sl)}
                          className="p-1.5 rounded text-blue-600 hover:bg-blue-50 transition-colors"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {!loading && totalCustomers > PAGE_SIZE && !filters.chooseFirst ? (
            <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-slate-200 pt-4">
              <p className="text-sm text-slate-600">
                Page {page} of {totalPages}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-200 text-sm disabled:opacity-50 hover:bg-slate-50"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Previous
                </button>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-200 text-sm disabled:opacity-50 hover:bg-slate-50"
                >
                  Next
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* User Details Modal */}
      <Dialog open={showUserDetails} onOpenChange={setShowUserDetails}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto mx-auto p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-slate-200">
            <DialogTitle className="pr-12 text-xl font-bold text-slate-900">User Details</DialogTitle>
          </DialogHeader>

          {loadingDetails ? (
            <div className="px-6 py-8 text-center">
              <div className="text-sm text-slate-500">Loading user details...</div>
            </div>
          ) : userDetails ? (
            <div className="space-y-4 px-6 py-5">
              {/* Profile Section */}
              <div className="bg-slate-50 rounded-xl p-4 sm:p-5">
                <div className="flex flex-col sm:flex-row sm:items-start gap-4">
                  <div className="w-16 h-16 rounded-full bg-slate-200 flex items-center justify-center flex-shrink-0">
                    {userDetails.profileImage ? (
                      <img src={userDetails.profileImage} alt={userDetails.name} className="w-full h-full rounded-full object-cover" />
                    ) : (
                      <User className="w-8 h-8 text-slate-400" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <h3 className="text-lg font-bold text-slate-900">{userDetails.name}</h3>
                      {userDetails.isActive ? (
                        <span className="px-2 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-700 flex items-center gap-1">
                          <CheckCircle className="w-3 h-3" />
                          Active
                        </span>
                      ) : (
                        <span className="px-2 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700 flex items-center gap-1">
                          <XCircle className="w-3 h-3" />
                          Inactive
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                      <div className="flex items-center gap-2 text-sm text-slate-600 min-w-0">
                        <Mail className="w-4 h-4" />
                        <span className="truncate">{userDetails.email}</span>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-slate-600 min-w-0">
                        <Phone className="w-4 h-4" />
                        <span>{userDetails.phone}</span>
                        {userDetails.phoneVerified && (
                          <CheckCircle className="w-3 h-3 text-green-600" />
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <CalendarIcon className="w-4 h-4" />
                        <span>Joined: {formatDateTime(userDetails.joiningDate)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Statistics Section */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="bg-blue-50 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Package className="w-4 h-4 text-blue-600" />
                    <span className="text-xs font-semibold text-slate-700">Total Orders</span>
                  </div>
                  <p className="text-xl font-bold text-blue-600">{userDetails.totalOrders || 0}</p>
                </div>
                <div className="bg-green-50 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <IndianRupee className="w-4 h-4 text-green-600" />
                    <span className="text-xs font-semibold text-slate-700">Total Spent</span>
                  </div>
                  <p className="text-xl font-bold text-green-600">
                    Rs. {(userDetails.totalOrderAmount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                </div>
                <div className="bg-purple-50 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <CalendarIcon className="w-4 h-4 text-purple-600" />
                    <span className="text-xs font-semibold text-slate-700">Member Since</span>
                  </div>
                  <p className="text-base font-bold text-purple-600">{formatDateTime(userDetails.joiningDate)}</p>
                </div>
              </div>

              {/* Addresses Section */}
              {userDetails.addresses && userDetails.addresses.length > 0 && (
                <div>
                  <h4 className="text-base font-bold text-slate-900 mb-2 flex items-center gap-2">
                    <MapPin className="w-4 h-4" />
                    Addresses
                  </h4>
                  <div className="space-y-2">
                    {userDetails.addresses.map((address, index) => (
                      <div key={index} className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-semibold text-slate-700">{address.label || 'Address'}</span>
                          {address.isDefault && (
                            <span className="px-2 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-700">
                              Default
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-slate-600">
                          {address.street}
                          {address.additionalDetails && `, ${address.additionalDetails}`}
                          {address.city && `, ${address.city}`}
                          {address.state && `, ${address.state}`}
                          {address.zipCode && ` - ${address.zipCode}`}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Wallet Statement Section */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-base font-bold text-slate-900 flex items-center gap-2">
                    <Wallet className="w-4 h-4" />
                    Wallet Statement
                  </h4>
                  {userDetails.walletTransactions && userDetails.walletTransactions.length > 0 && (
                    <button
                      type="button"
                      onClick={() => downloadWalletStatement(userDetails, getFilteredWalletTransactions())}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 hover:text-emerald-800"
                    >
                      <FileDown className="w-3.5 h-3.5" />
                      Download PDF
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div className="bg-emerald-50 rounded-lg p-3">
                    <p className="text-xs font-semibold text-slate-700 mb-1">Current Balance</p>
                    <p className="text-xl font-bold text-emerald-700">{formatMoney(userDetails.walletBalance)}</p>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3">
                    <p className="text-xs font-semibold text-slate-700 mb-1">Referral Earnings</p>
                    <p className="text-xl font-bold text-slate-700">{formatMoney(userDetails.walletReferralEarnings)}</p>
                  </div>
                </div>
                {userDetails.walletTransactions && userDetails.walletTransactions.length > 0 ? (
                  <>
                    {/* Type and date filters. They only ever hide rows -- see
                        getFilteredWalletTransactions -- so the Balance column
                        stays the real account history whatever is selected. */}
                    <div className="flex flex-wrap items-end gap-2 mb-2">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-500 mb-0.5">Type</label>
                        <select
                          value={walletFilters.type}
                          onChange={(e) => setWalletFilters((f) => ({ ...f, type: e.target.value }))}
                          className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                        >
                          <option value="all">All</option>
                          <option value="credit">Credit</option>
                          <option value="debit">Debit</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-500 mb-0.5">From</label>
                        <input
                          type="date"
                          value={walletFilters.from}
                          max={walletFilters.to || undefined}
                          onChange={(e) => setWalletFilters((f) => ({ ...f, from: e.target.value }))}
                          className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-500 mb-0.5">To</label>
                        <input
                          type="date"
                          value={walletFilters.to}
                          min={walletFilters.from || undefined}
                          onChange={(e) => setWalletFilters((f) => ({ ...f, to: e.target.value }))}
                          className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                        />
                      </div>
                      {walletFiltersActive && (
                        <button
                          type="button"
                          onClick={() => setWalletFilters({ type: "all", from: "", to: "" })}
                          className="h-8 text-xs font-semibold text-slate-500 hover:text-slate-700"
                        >
                          Clear
                        </button>
                      )}
                    </div>

                    {(() => {
                      const filtered = getFilteredWalletTransactions()
                      return (
                        <>
                          {/* Opening balance is what the account held before the
                              oldest entry in the *full* statement -- unaffected
                              by the filters above, because it is a fact about
                              the account, not about what is currently shown. */}
                          <p className="text-xs text-slate-500 mb-2">
                            Opening balance {formatMoney(userDetails.walletOpeningBalance)} ·{" "}
                            {walletFiltersActive
                              ? `showing ${filtered.length} of ${userDetails.walletTransactions.length} entries`
                              : `${userDetails.walletTransactions.length} entr${userDetails.walletTransactions.length === 1 ? "y" : "ies"}`}
                          </p>
                          {filtered.length > 0 ? (
                            <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
                              <table className="w-full min-w-[520px] text-xs">
                                <thead className="sticky top-0 bg-slate-100">
                                  <tr>
                                    <th className="px-3 py-2 text-left font-semibold text-slate-600">Date</th>
                                    <th className="px-3 py-2 text-left font-semibold text-slate-600">Description</th>
                                    <th className="px-3 py-2 text-right font-semibold text-slate-600">Debit</th>
                                    <th className="px-3 py-2 text-right font-semibold text-slate-600">Credit</th>
                                    <th className="px-3 py-2 text-right font-semibold text-slate-600">Balance</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100 bg-white">
                                  {filtered.map((tx) => (
                                    <tr key={tx.id}>
                                      <td className="px-3 py-2 whitespace-nowrap text-slate-600">{formatDateTime(tx.date)}</td>
                                      <td className="px-3 py-2 text-slate-800">{tx.description || tx.type}</td>
                                      <td className="px-3 py-2 text-right text-rose-600">
                                        {tx.type === "deduction" ? formatMoney(tx.amount) : "—"}
                                      </td>
                                      <td className="px-3 py-2 text-right text-emerald-600">
                                        {tx.type !== "deduction" ? formatMoney(tx.amount) : "—"}
                                      </td>
                                      <td className="px-3 py-2 text-right font-semibold text-slate-900">{formatMoney(tx.balanceAfter)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <p className="text-sm text-slate-500">No entries match these filters.</p>
                          )}
                        </>
                      )
                    })()}
                  </>
                ) : (
                  <p className="text-sm text-slate-500">No wallet transactions yet.</p>
                )}
              </div>

              {/* Recent Orders Section */}
              {userDetails.orders && userDetails.orders.length > 0 && (
                <div>
                  <h4 className="text-base font-bold text-slate-900 mb-2 flex items-center gap-2">
                    <Package className="w-4 h-4" />
                    Recent Orders
                  </h4>
                  <div className="space-y-2">
                    {userDetails.orders.slice(0, 5).map((order, index) => (
                      <div key={index} className="bg-slate-50 rounded-lg p-3 border border-slate-200 flex items-center justify-between">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{order.orderId}</p>
                          <p className="text-xs text-slate-600">{order.restaurantName}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold text-slate-900">Rs. {(order.total || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                          <p className="text-xs text-slate-600 capitalize">{order.status}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Additional Info */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {userDetails.gender && (
                  <div className="bg-slate-50 rounded-lg p-3">
                    <p className="text-xs font-semibold text-slate-700 mb-1">Gender</p>
                    <p className="text-sm text-slate-600 capitalize">{userDetails.gender}</p>
                  </div>
                )}
                {userDetails.dateOfBirth && (
                  <div className="bg-slate-50 rounded-lg p-3">
                    <p className="text-xs font-semibold text-slate-700 mb-1">Date of Birth</p>
                    <p className="text-sm text-slate-600">
                      {new Date(userDetails.dateOfBirth).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric'
                      })}
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="py-8 text-center">
              <div className="text-sm text-slate-500">No user details available</div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

