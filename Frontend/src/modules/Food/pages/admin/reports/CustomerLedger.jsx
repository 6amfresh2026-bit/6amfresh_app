import { Users } from "lucide-react"
import { adminAPI } from "@food/api"
import DataReport, { inr, dateLabel } from "./DataReport"

export default function CustomerLedger() {
  return (
    <DataReport
      title="Customer ledger"
      description="Orders, total spent and last order per customer. Cancelled orders are excluded."
      icon={Users}
      csvName="customer-ledger"
      showZone
      showSeller
      rowKey={(r) => r.userId}
      fetchReport={async (params) => {
        const res = await adminAPI.getCustomerLedgerReport(params)
        const d = res?.data?.data
        return { rows: d?.customers || [], summary: d?.summary || null }
      }}
      tiles={[
        { label: "Customers", key: "customers" },
        { label: "Orders", key: "orders" },
        { label: "Total Spent", key: "totalSpent", money: true },
      ]}
      columns={[
        { key: "name", label: "Customer", render: (r) => (
          <div>
            <div className="text-sm font-semibold text-slate-900">{r.name || "Guest"}</div>
            {(r.phone || r.email) && <div className="text-xs text-slate-500">{[r.phone, r.email].filter(Boolean).join(" · ")}</div>}
          </div>
        ) },
        { key: "orders", label: "Orders", align: "right" },
        { key: "totalSpent", label: "Total Spent", align: "right", money: true, className: "font-medium text-slate-900" },
        { key: "avgOrder", label: "Avg Order", align: "right", money: true },
        { key: "lastOrder", label: "Last Order", align: "right", render: (r) => dateLabel(r.lastOrder) },
      ]}
      footer={(s) => ["Total", s.orders, inr(s.totalSpent), "", ""]}
    />
  )
}
