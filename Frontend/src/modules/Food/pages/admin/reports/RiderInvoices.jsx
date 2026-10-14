import { Receipt } from "lucide-react"
import { adminAPI } from "@food/api"
import DataReport, { inr } from "./DataReport"

export default function RiderInvoices() {
  return (
    <DataReport
      title="Rider invoices"
      description="Deliveries and earnings per rider from the transaction ledger, with settled and pending amounts."
      icon={Receipt}
      csvName="rider-invoices"
      rowKey={(r) => r.riderId}
      fetchReport={async (params) => {
        const res = await adminAPI.getRiderInvoicesReport(params)
        const d = res?.data?.data
        return { rows: d?.riders || [], summary: d?.summary || null }
      }}
      tiles={[
        { label: "Riders", key: "riders" },
        { label: "Deliveries", key: "deliveries" },
        { label: "Earnings", key: "earnings", money: true },
        { label: "Settled", key: "settled", money: true },
        { label: "Pending", key: "pending", money: true, warn: true },
      ]}
      columns={[
        { key: "rider", label: "Rider", render: (r) => (
          <div>
            <div className="text-sm font-semibold text-slate-900">{r.rider}</div>
            {r.phone && <div className="text-xs text-slate-500">{r.phone}</div>}
          </div>
        ) },
        { key: "deliveries", label: "Deliveries", align: "right" },
        { key: "earnings", label: "Earnings", align: "right", money: true, className: "font-medium text-slate-900" },
        { key: "settled", label: "Settled", align: "right", money: true, className: "text-emerald-700" },
        { key: "pending", label: "Pending", align: "right", money: true, className: "text-red-600" },
      ]}
      footer={(s) => ["Total", s.deliveries, inr(s.earnings), inr(s.settled), inr(s.pending)]}
    />
  )
}
