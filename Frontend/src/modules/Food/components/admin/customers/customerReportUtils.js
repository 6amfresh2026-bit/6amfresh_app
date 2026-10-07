// Comprehensive, single-customer report builders. Unlike customersExportUtils
// (which exports the flat list rows), these take the FULL customer object
// returned by adminAPI.getCustomerById -> data.user, and lay out everything the
// admin holds on that account: profile, statistics, addresses, the complete
// order history, and the full wallet statement. One account, everything in it.

const debugError = (...args) => {}

const money = (value) =>
  `Rs. ${(Number(value) || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`

const dateTime = (value) => {
  if (!value) return "-"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })
}

const addressLine = (a = {}) =>
  [
    a.label,
    a.street,
    a.additionalDetails,
    a.city,
    a.state,
    a.zipCode ? `- ${a.zipCode}` : "",
    a.isDefault ? "(Default)" : "",
  ]
    .filter(Boolean)
    .join(", ")

const safeName = (user) =>
  String(user?.name || "customer").replace(/[^a-z0-9]+/gi, "_")

const timestamp = () => new Date().toISOString().split("T")[0]

const triggerDownload = (content, filename, mime) => {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.style.visibility = "hidden"
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

// Normalise the varied field names into one predictable shape.
const normalise = (user = {}) => {
  const orders = Array.isArray(user.orders) ? user.orders : []
  const txns = Array.isArray(user.walletTransactions) ? user.walletTransactions : []
  const addresses = Array.isArray(user.addresses) ? user.addresses : []
  return {
    id: user._id || user.id || "",
    name: user.name || "N/A",
    email: user.email || "N/A",
    phone: user.phone || "N/A",
    phoneVerified: Boolean(user.phoneVerified),
    status: user.isActive != null ? user.isActive : user.status,
    gender: user.gender || "",
    dateOfBirth: user.dateOfBirth || "",
    joiningDate: user.joiningDate || "",
    totalOrders: user.totalOrders ?? user.totalOrder ?? orders.length ?? 0,
    totalOrderAmount: user.totalOrderAmount ?? 0,
    walletBalance: user.walletBalance ?? 0,
    walletOpeningBalance: user.walletOpeningBalance ?? 0,
    walletReferralEarnings: user.walletReferralEarnings ?? 0,
    addresses,
    orders,
    walletTransactions: txns,
  }
}

// ---- JSON: the complete object, nothing dropped ----------------------------
export const downloadCustomerReportJSON = (user) => {
  const u = normalise(user)
  const payload = {
    exportDate: new Date().toISOString(),
    customer: {
      ...u,
      status: u.status ? "Active" : "Inactive",
      joiningDate: dateTime(u.joiningDate),
    },
  }
  triggerDownload(
    JSON.stringify(payload, null, 2),
    `customer_report_${safeName(user)}_${timestamp()}.json`,
    "application/json;charset=utf-8",
  )
}

// ---- CSV: sectioned (profile, stats, addresses, orders, wallet) ------------
const esc = (value) => {
  if (value === null || value === undefined) return ""
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const row = (cells) => cells.map(esc).join(",")

export const downloadCustomerReportCSV = (user) => {
  const u = normalise(user)
  const lines = []

  lines.push("CUSTOMER PROFILE")
  lines.push(row(["Name", u.name]))
  lines.push(row(["Email", u.email]))
  lines.push(row(["Phone", `${u.phone}${u.phoneVerified ? " (verified)" : ""}`]))
  lines.push(row(["Status", u.status ? "Active" : "Inactive"]))
  if (u.gender) lines.push(row(["Gender", u.gender]))
  if (u.dateOfBirth) lines.push(row(["Date of Birth", dateTime(u.dateOfBirth)]))
  lines.push(row(["Joined", dateTime(u.joiningDate)]))
  lines.push("")

  lines.push("STATISTICS")
  lines.push(row(["Total Orders", u.totalOrders]))
  lines.push(row(["Total Spent", money(u.totalOrderAmount)]))
  lines.push(row(["Wallet Balance", money(u.walletBalance)]))
  lines.push(row(["Wallet Opening Balance", money(u.walletOpeningBalance)]))
  lines.push(row(["Referral Earnings", money(u.walletReferralEarnings)]))
  lines.push("")

  lines.push("ADDRESSES")
  if (u.addresses.length) {
    u.addresses.forEach((a, i) => lines.push(row([`#${i + 1}`, addressLine(a)])))
  } else {
    lines.push(row(["", "No addresses on record"]))
  }
  lines.push("")

  lines.push("ORDER HISTORY")
  lines.push(row(["SI", "Order ID", "Restaurant", "Amount", "Status"]))
  if (u.orders.length) {
    u.orders.forEach((o, i) =>
      lines.push(row([i + 1, o.orderId || "-", o.restaurantName || "-", money(o.total), o.status || "-"])),
    )
  } else {
    lines.push(row(["", "No orders on record"]))
  }
  lines.push("")

  lines.push("WALLET STATEMENT")
  lines.push(row(["Opening Balance", money(u.walletOpeningBalance)]))
  lines.push(row(["Date", "Description", "Debit", "Credit", "Balance"]))
  if (u.walletTransactions.length) {
    u.walletTransactions.forEach((t) =>
      lines.push(
        row([
          dateTime(t.date),
          t.description || t.type || "-",
          t.type === "deduction" ? money(t.amount) : "-",
          t.type !== "deduction" ? money(t.amount) : "-",
          money(t.balanceAfter),
        ]),
      ),
    )
  } else {
    lines.push(row(["", "No wallet transactions on record"]))
  }
  lines.push(row(["Closing Balance", "", "", "", money(u.walletBalance)]))

  triggerDownload(
    "﻿" + lines.join("\n"),
    `customer_report_${safeName(user)}_${timestamp()}.csv`,
    "text/csv;charset=utf-8;",
  )
}

// ---- Excel: multi-table HTML workbook --------------------------------------
export const downloadCustomerReportExcel = (user) => {
  const u = normalise(user)
  const th = (t) => `<th style="background:#0f766e;color:#fff;padding:6px;text-align:left">${t}</th>`
  const kv = (k, v) => `<tr><td style="padding:6px;font-weight:bold;background:#f1f5f9">${k}</td><td style="padding:6px">${v}</td></tr>`

  const addressesRows = u.addresses.length
    ? u.addresses.map((a, i) => `<tr><td style="padding:6px">#${i + 1}</td><td style="padding:6px">${addressLine(a)}</td></tr>`).join("")
    : `<tr><td style="padding:6px" colspan="2">No addresses on record</td></tr>`

  const orderRows = u.orders.length
    ? u.orders.map((o, i) => `<tr><td style="padding:6px">${i + 1}</td><td style="padding:6px">${o.orderId || "-"}</td><td style="padding:6px">${o.restaurantName || "-"}</td><td style="padding:6px">${money(o.total)}</td><td style="padding:6px">${o.status || "-"}</td></tr>`).join("")
    : `<tr><td style="padding:6px" colspan="5">No orders on record</td></tr>`

  const walletRows = u.walletTransactions.length
    ? u.walletTransactions.map((t) => `<tr><td style="padding:6px">${dateTime(t.date)}</td><td style="padding:6px">${t.description || t.type || "-"}</td><td style="padding:6px">${t.type === "deduction" ? money(t.amount) : "-"}</td><td style="padding:6px">${t.type !== "deduction" ? money(t.amount) : "-"}</td><td style="padding:6px">${money(t.balanceAfter)}</td></tr>`).join("")
    : `<tr><td style="padding:6px" colspan="5">No wallet transactions on record</td></tr>`

  const html = `
    <html><head><meta charset="utf-8"><style>table{border-collapse:collapse;width:100%;margin-bottom:18px}td,th{border:1px solid #e2e8f0}h2{font-family:sans-serif;color:#0f172a;margin:14px 0 6px}</style></head>
    <body style="font-family:sans-serif">
      <h1 style="color:#0f766e">6AM Fresh — Customer Report</h1>
      <h2>Profile</h2>
      <table>
        ${kv("Name", u.name)}${kv("Email", u.email)}${kv("Phone", `${u.phone}${u.phoneVerified ? " (verified)" : ""}`)}
        ${kv("Status", u.status ? "Active" : "Inactive")}${u.gender ? kv("Gender", u.gender) : ""}${u.dateOfBirth ? kv("Date of Birth", dateTime(u.dateOfBirth)) : ""}${kv("Joined", dateTime(u.joiningDate))}
      </table>
      <h2>Statistics</h2>
      <table>
        ${kv("Total Orders", u.totalOrders)}${kv("Total Spent", money(u.totalOrderAmount))}${kv("Wallet Balance", money(u.walletBalance))}${kv("Wallet Opening Balance", money(u.walletOpeningBalance))}${kv("Referral Earnings", money(u.walletReferralEarnings))}
      </table>
      <h2>Addresses</h2>
      <table><thead><tr>${th("#")}${th("Address")}</tr></thead><tbody>${addressesRows}</tbody></table>
      <h2>Order History</h2>
      <table><thead><tr>${th("SI")}${th("Order ID")}${th("Restaurant")}${th("Amount")}${th("Status")}</tr></thead><tbody>${orderRows}</tbody></table>
      <h2>Wallet Statement (Opening ${money(u.walletOpeningBalance)} → Closing ${money(u.walletBalance)})</h2>
      <table><thead><tr>${th("Date")}${th("Description")}${th("Debit")}${th("Credit")}${th("Balance")}</tr></thead><tbody>${walletRows}</tbody></table>
    </body></html>`

  triggerDownload(html, `customer_report_${safeName(user)}_${timestamp()}.xls`, "application/vnd.ms-excel")
}

// ---- PDF: the full formatted statement, house style ------------------------
export const downloadCustomerReportPDF = async (user) => {
  const u = normalise(user)
  try {
    const { default: jsPDF } = await import("jspdf")
    const { default: autoTable } = await import("jspdf-autotable")

    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" })
    const pageWidth = doc.internal.pageSize.getWidth()

    // Header bar
    doc.setFillColor(15, 118, 110)
    doc.rect(0, 0, pageWidth, 32, "F")
    doc.setTextColor(255, 255, 255)
    doc.setFontSize(15)
    doc.setFont(undefined, "bold")
    doc.text("6AM Fresh", 14, 14)
    doc.setFontSize(10)
    doc.setFont(undefined, "normal")
    doc.text("Customer Report", 14, 21)
    doc.setFontSize(8.5)
    doc.text(`${u.name} · ${u.phone}`, 14, 27)

    // Profile + statistics
    autoTable(doc, {
      startY: 40,
      head: [["Profile", ""]],
      body: [
        ["Email", u.email],
        ["Phone", `${u.phone}${u.phoneVerified ? " (verified)" : ""}`],
        ["Status", u.status ? "Active" : "Inactive"],
        ...(u.gender ? [["Gender", String(u.gender)]] : []),
        ...(u.dateOfBirth ? [["Date of Birth", dateTime(u.dateOfBirth)]] : []),
        ["Joined", dateTime(u.joiningDate)],
        ["Total Orders", String(u.totalOrders)],
        ["Total Spent", money(u.totalOrderAmount)],
        ["Wallet Balance", money(u.walletBalance)],
        ["Referral Earnings", money(u.walletReferralEarnings)],
      ],
      theme: "grid",
      headStyles: { fillColor: [15, 118, 110], textColor: 255, fontSize: 9, fontStyle: "bold" },
      bodyStyles: { fontSize: 8.5, textColor: [30, 41, 59] },
      columnStyles: { 0: { cellWidth: 55, fontStyle: "bold" }, 1: { cellWidth: 127 } },
      margin: { left: 14, right: 14 },
    })

    // Addresses
    autoTable(doc, {
      startY: (doc.lastAutoTable?.finalY || 60) + 6,
      head: [["Addresses"]],
      body: u.addresses.length
        ? u.addresses.map((a) => [addressLine(a)])
        : [["No addresses on record"]],
      theme: "grid",
      headStyles: { fillColor: [15, 118, 110], textColor: 255, fontSize: 9, fontStyle: "bold" },
      bodyStyles: { fontSize: 8.5, textColor: [30, 41, 59] },
      margin: { left: 14, right: 14 },
    })

    // Order history
    autoTable(doc, {
      startY: (doc.lastAutoTable?.finalY || 80) + 6,
      head: [["#", "Order ID", "Restaurant", "Amount", "Status"]],
      body: u.orders.length
        ? u.orders.map((o, i) => [i + 1, o.orderId || "-", o.restaurantName || "-", money(o.total), o.status || "-"])
        : [["-", "No orders on record", "", "", ""]],
      theme: "grid",
      headStyles: { fillColor: [15, 118, 110], textColor: 255, fontSize: 9, fontStyle: "bold" },
      bodyStyles: { fontSize: 8, textColor: [30, 41, 59] },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: {
        0: { cellWidth: 10 },
        3: { halign: "right" },
      },
      margin: { left: 14, right: 14 },
    })

    // Wallet statement
    autoTable(doc, {
      startY: (doc.lastAutoTable?.finalY || 100) + 6,
      body: [[
        `Opening Balance: ${money(u.walletOpeningBalance)}`,
        `Closing Balance: ${money(u.walletBalance)}`,
      ]],
      theme: "plain",
      styles: { fontSize: 9, fontStyle: "bold", textColor: [30, 41, 59], fillColor: [241, 245, 249] },
      columnStyles: { 0: { cellWidth: 91 }, 1: { cellWidth: 91, textColor: [15, 118, 110] } },
      margin: { left: 14, right: 14 },
    })
    autoTable(doc, {
      startY: (doc.lastAutoTable?.finalY || 110) + 2,
      head: [["Date", "Description", "Debit", "Credit", "Balance"]],
      body: u.walletTransactions.length
        ? u.walletTransactions.map((t) => [
            dateTime(t.date),
            t.description || t.type || "-",
            t.type === "deduction" ? money(t.amount) : "-",
            t.type !== "deduction" ? money(t.amount) : "-",
            money(t.balanceAfter),
          ])
        : [["-", "No wallet transactions on record", "-", "-", money(u.walletBalance)]],
      theme: "grid",
      headStyles: { fillColor: [15, 118, 110], textColor: 255, fontSize: 9, fontStyle: "bold" },
      bodyStyles: { fontSize: 8, textColor: [30, 41, 59] },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: {
        2: { halign: "right", textColor: [190, 18, 60] },
        3: { halign: "right", textColor: [4, 120, 87] },
        4: { halign: "right", fontStyle: "bold" },
      },
      margin: { left: 14, right: 14 },
    })

    doc.save(`customer_report_${safeName(user)}_${timestamp()}.pdf`)
  } catch (error) {
    debugError("Error generating customer report PDF:", error)
    throw error
  }
}
