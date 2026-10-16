import { useParams, Link } from "react-router-dom"

import { Download, ArrowLeft, FileText, Printer } from "lucide-react"
import { useRef, useState, useEffect } from "react"
import AnimatedPage from "@food/components/user/AnimatedPage"
import ScrollReveal from "@food/components/user/ScrollReveal"
import { Card, CardHeader, CardTitle, CardContent } from "@food/components/ui/card"
import { Button } from "@food/components/ui/button"
import { Badge } from "@food/components/ui/badge"
import { useOrders } from "@food/context/OrdersContext"
import { useCompanyName } from "@food/hooks/useCompanyName"
import { barcodeSvg } from "@food/utils/barcode"
import { orderAPI } from "@food/api"

/**
 * The invoice reads an order in one flat shape (subtotal, deliveryFee, tax, total, address),
 * but the API sends the amounts under `pricing`, the address as `deliveryAddress` and the
 * customer-facing number as `orderId`. Reading the API order as-is crashed the page, so
 * every order is mapped into the flat shape first; an order already in it is left alone.
 */
const toInvoiceOrder = (o) => {
  if (!o) return o
  const p = o.pricing || {}
  const num = (v) => Number(v) || 0
  return {
    ...o,
    id: o.orderId || o.order_id || o.id || o._id,
    items: (o.items || []).map((it, i) => ({
      ...it,
      id: it.id || it.itemId || i,
      price: num(it.price),
      quantity: num(it.quantity),
    })),
    subtotal: num(o.subtotal ?? p.subtotal),
    deliveryFee: num(o.deliveryFee ?? p.deliveryFee),
    tax: num(o.tax ?? p.tax),
    total: num(o.total ?? p.total),
    address: o.address || o.deliveryAddress || {},
  }
}

const rupees = (n) => `₹${(Number(n) || 0).toFixed(2)}`

export default function OrderInvoice() {
  const companyName = useCompanyName()
  const { orderId } = useParams()
  const { getOrderById } = useOrders()
  const [order, setOrder] = useState(() => toInvoiceOrder(getOrderById(orderId)))
  const [loading, setLoading] = useState(!order)
  const [error, setError] = useState(null)
  const invoiceRef = useRef(null)
  // Our own SVG, built from the invoice number alone (rect geometry; no markup from the order).
  // Whole-pixel bars (module 2): a fractional bar width blurs when drawn on a screen and stops scanning.
  const invoiceBarcode = order?.id ? barcodeSvg(String(order.id), { height: 40, module: 2 }) : ""

  useEffect(() => {
    if (order) return

    const fetchOrder = async () => {
      try {
        setLoading(true)
        const response = await orderAPI.getOrderDetails(orderId)
        if (response.data?.success && response.data.data?.order) {
          setOrder(toInvoiceOrder(response.data.data.order))
        } else {
          setError("Order not found")
        }
      } catch (err) {
        setError("Failed to load invoice details")
      } finally {
        setLoading(false)
      }
    }

    fetchOrder()
  }, [orderId, order])

  if (loading) {
    return (
      <AnimatedPage className="min-h-screen bg-[#f5f5f5] dark:bg-[#0a0a0a] p-4">
        <div className="max-w-4xl mx-auto text-center py-20">
          <div className="w-8 h-8 border-2 border-[#EB590E] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Generating invoice...</p>
        </div>
      </AnimatedPage>
    )
  }

  if (error || !order) {
    return (
      <AnimatedPage className="min-h-screen bg-[#f5f5f5] dark:bg-[#0a0a0a] p-4">
        <div className="max-w-4xl mx-auto text-center py-20">
          <h1 className="text-lg sm:text-xl md:text-2xl font-bold mb-4">{error || 'Order Not Found'}</h1>
          <Link to="/user/orders">
            <Button>Back to Orders</Button>
          </Link>
        </div>
      </AnimatedPage>
    )
  }

  const formatDate = (dateString) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const handlePrint = () => {
    const printWindow = window.open('', '_blank')
    const printContent = invoiceRef.current.innerHTML

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Invoice - ${order.id}</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              padding: 40px;
              color: #333;
            }
            .invoice-header {
              border-bottom: 2px solid #EB590E;
              padding-bottom: 20px;
              margin-bottom: 30px;
            }
            .invoice-title {
              font-size: 32px;
              font-weight: bold;
              color: #EB590E;
              margin-bottom: 10px;
            }
            .invoice-details {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 20px;
              margin: 30px 0;
            }
            .invoice-items {
              margin: 30px 0;
            }
            table {
              width: 100%;
              border-collapse: collapse;
              margin: 20px 0;
            }
            th, td {
              padding: 12px;
              text-align: left;
              border-bottom: 1px solid #ddd;
            }
            th {
              background-color: #fed7aa;
              font-weight: bold;
            }
            .total-section {
              margin-top: 30px;
              text-align: right;
            }
            .total-row {
              padding: 10px 0;
              font-size: 18px;
            }
            .grand-total {
              font-size: 24px;
              font-weight: bold;
              color: #EB590E;
              border-top: 2px solid #EB590E;
              padding-top: 10px;
            }
            @media print {
              body { margin: 0; padding: 20px; }
              .no-print { display: none; }
            }
          </style>
        </head>
        <body>
          ${printContent}
        </body>
      </html>
    `)
    printWindow.document.close()
    printWindow.focus()
    setTimeout(() => {
      printWindow.print()
    }, 250)
  }

  const handleDownloadPDF = () => {
    handlePrint()
  }

  return (
    <AnimatedPage className="min-h-screen bg-gradient-to-b from-yellow-50/30 via-white to-orange-50/20 dark:from-[#0a0a0a] dark:via-[#1a1a1a] dark:to-[#0a0a0a] p-3 sm:p-4 md:p-6 lg:p-8">
      <div className="max-w-6xl mx-auto space-y-4 sm:space-y-6 md:space-y-8">
        <ScrollReveal>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4 mb-4 sm:mb-6">
            <div className="flex items-center gap-3 sm:gap-4">
              <Link to={`/user/orders/${orderId}`}>
                <Button variant="ghost" size="icon" className="rounded-full h-8 w-8 sm:h-10 sm:w-10">
                  <ArrowLeft className="h-4 w-4 sm:h-5 sm:w-5" />
                </Button>
              </Link>
              <div>
                <h1 className="text-lg sm:text-xl md:text-2xl font-bold">Invoice</h1>
                <p className="text-muted-foreground text-sm sm:text-base">Order {order.id}</p>
              </div>
            </div>
            <div className="flex gap-2 no-print">
              <Button
                variant="outline"
                onClick={handlePrint}
                className="flex items-center gap-2 text-xs sm:text-sm h-9 sm:h-10"
              >
                <Printer className="h-3 w-3 sm:h-4 sm:w-4" />
                <span className="hidden sm:inline">Print</span>
              </Button>
              <Button
                onClick={handleDownloadPDF}
                className="bg-[#EB590E] hover:bg-[#D94F0C] flex items-center gap-2 text-xs sm:text-sm h-9 sm:h-10"
              >
                <Download className="h-3 w-3 sm:h-4 sm:w-4 text-white" />
                <span className="hidden sm:inline text-white">Download PDF</span>
                <span className="sm:hidden text-white">PDF</span>
              </Button>
            </div>
          </div>
        </ScrollReveal>

        <ScrollReveal delay={0.1}>
          <Card ref={invoiceRef} className="dark:bg-[#1a1a1a] dark:border-gray-800">
            <CardContent className="p-4 sm:p-6 md:p-8 lg:p-10">
              {/* Invoice Header */}
              <div className="invoice-header">
                <div className="flex items-center gap-2 sm:gap-3 mb-3 sm:mb-4">
                  <FileText className="h-6 w-6 sm:h-8 sm:w-8 text-[#EB590E]" />
                  <h2 className="invoice-title text-xl sm:text-2xl md:text-3xl text-[#EB590E] font-bold">INVOICE</h2>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-0">
                  <div>
                    <p className="text-xs sm:text-sm text-muted-foreground">{companyName}</p>
                    <p className="text-xs sm:text-sm text-muted-foreground">Food Delivery Platform</p>
                  </div>
                  <Badge className="bg-[#EB590E] text-white text-sm sm:text-base md:text-lg px-3 sm:px-4 py-1.5 sm:py-2 w-fit">
                    {order.status.toUpperCase()}
                  </Badge>
                </div>
              </div>

              {/* Invoice Details */}
              <div className="invoice-details grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 md:gap-8 mt-4 sm:mt-6">
                <div>
                  <h3 className="font-bold mb-2 text-sm sm:text-base">Bill To:</h3>
                  {(order.address?.flatNumber || order.address?.blockNumber) && (
                    <p className="text-xs sm:text-sm">
                      {[
                        order.address?.flatNumber && `Flat ${order.address.flatNumber}`,
                        order.address?.blockNumber && `Block ${order.address.blockNumber}`,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                  )}
                  <p className="text-xs sm:text-sm">{order.address?.street}</p>
                  {order.address?.colonyName && (
                    <p className="text-xs sm:text-sm">{order.address.colonyName}</p>
                  )}
                  {order.address?.additionalDetails && (
                    <p className="text-xs sm:text-sm">{order.address.additionalDetails}</p>
                  )}
                  <p className="text-xs sm:text-sm">
                    {order.address?.city}, {order.address?.state} {order.address?.zipCode}
                  </p>
                </div>
                <div className="text-left sm:text-right">
                  <h3 className="font-bold mb-2 text-sm sm:text-base">Invoice Details:</h3>
                  <p className="text-xs sm:text-sm"><strong>Invoice #:</strong> {order.id}</p>
                  {/* The invoice number as a scannable barcode, so support or a returns desk can pull the order up with a scan. */}
                  {invoiceBarcode ? (
                    <div className="mt-1 sm:flex sm:justify-end [&>svg]:h-auto [&>svg]:max-w-full" aria-label={`Barcode for invoice ${order.id}`} dangerouslySetInnerHTML={{ __html: invoiceBarcode }} />
                  ) : null}
                  <p className="text-xs sm:text-sm"><strong>Date:</strong> {formatDate(order.createdAt)}</p>
                  <p className="text-xs sm:text-sm"><strong>Payment:</strong> {String(order.paymentMethod?.type || order.payment?.method || (typeof order.paymentMethod === "string" ? order.paymentMethod : "") || "Card").toUpperCase()}</p>
                </div>
              </div>

              {/* Items Table */}
              <div className="invoice-items mt-4 sm:mt-6">
                <h3 className="font-bold mb-3 sm:mb-4 text-sm sm:text-base">Order Items:</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs sm:text-sm">
                    <thead>
                      <tr>
                        <th className="px-2 sm:px-3 py-2 text-left">Item</th>
                        <th className="px-2 sm:px-3 py-2 text-center hidden sm:table-cell">Quantity</th>
                        <th className="px-2 sm:px-3 py-2 text-right hidden md:table-cell">Unit Price</th>
                        <th className="px-2 sm:px-3 py-2 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {order.items.map((item) => (
                        <tr key={item.id} className="border-b">
                          <td className="px-2 sm:px-3 py-2 sm:py-3">
                            <div className="flex items-center gap-2 sm:gap-3">
                              <img
                                src={item.image}
                                alt={item.name}
                                className="w-8 h-8 sm:w-12 sm:h-12 object-cover rounded flex-shrink-0"
                              />
                              <div className="min-w-0 flex-1">
                                <span className="font-medium block">{item.name}</span>
                                {item.variantName ? (
                                  <span className="text-xs text-gray-500">{item.variantName}</span>
                                ) : null}
                                <span className="text-muted-foreground sm:hidden text-xs">
                                  Qty: {item.quantity} × {rupees(item.price)}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td className="px-2 sm:px-3 py-2 sm:py-3 text-center hidden sm:table-cell">{item.quantity}</td>
                          <td className="px-2 sm:px-3 py-2 sm:py-3 text-right hidden md:table-cell">{rupees(item.price)}</td>
                          <td className="px-2 sm:px-3 py-2 sm:py-3 text-right font-medium">{rupees(item.price * item.quantity)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Total Section */}
              <div className="total-section mt-4 sm:mt-6">
                <div className="total-row flex justify-between text-xs sm:text-sm sm:text-base py-1 sm:py-2">
                  <span>Subtotal:</span>
                  <span>{rupees(order.subtotal)}</span>
                </div>
                <div className="total-row flex justify-between text-xs sm:text-sm sm:text-base py-1 sm:py-2">
                  <span>Delivery Fee:</span>
                  <span>{rupees(order.deliveryFee)}</span>
                </div>
                <div className="total-row flex justify-between text-xs sm:text-sm sm:text-base py-1 sm:py-2">
                  <span>Tax:</span>
                  <span>{rupees(order.tax)}</span>
                </div>
                <div className="grand-total flex justify-between text-base sm:text-lg md:text-xl md:text-2xl pt-2 sm:pt-3 mt-2 sm:mt-3 border-t-2 border-[#EB590E]">
                  <span>Total:</span>
                  <span>{rupees(order.total)}</span>
                </div>
              </div>

              {/* Footer */}
              <div className="mt-6 sm:mt-8 pt-4 sm:pt-6 border-t text-center text-xs sm:text-sm text-muted-foreground">
                <p>Thank you for your order!</p>
                <p className="mt-1 sm:mt-2">For any queries, please contact our support team.</p>
              </div>
            </CardContent>
          </Card>
        </ScrollReveal>

        <ScrollReveal delay={0.2}>
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-4 no-print">
            <Link to={`/user/orders/${orderId}`} className="flex-1">
              <Button variant="outline" className="w-full text-sm sm:text-base h-10 sm:h-11">
                Track Order
              </Button>
            </Link>
            <Link to="/user/orders" className="flex-1">
              <Button variant="outline" className="w-full text-sm sm:text-base h-10 sm:h-11">
                Back to Orders
              </Button>
            </Link>
          </div>
        </ScrollReveal>
      </div>
    </AnimatedPage>
  )
}
