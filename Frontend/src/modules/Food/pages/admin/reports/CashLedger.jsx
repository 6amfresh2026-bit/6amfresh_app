import { Wallet } from "lucide-react"
import { adminAPI } from "@food/api"
import DataReport, { inr } from "./DataReport"

export default function CashLedger() {
  return (
    <DataReport
      title="Cash ledger"
      description="COD cash collected on delivered orders vs settled deposits, per rider. Outstanding is cash still in hand."
      icon={Wallet}
      csvName="cash-ledger"
      rowKey={(r) => r.riderId}
      fetchReport={async (params) => {
        const res = await adminAPI.getCashLedgerReport(params)
        const d = res?.data?.data
        return { rows: d?.rows || [], summary: d?.summary || null }
      }}
      tiles={[
        { label: "Riders", key: "riders" },
        { label: "COD Orders", key: "codOrders" },
        { label: "Collected", key: "collected", money: true },
        { label: "Settled", key: "settled", money: true },
        { label: "Outstanding", key: "outstanding", money: true, warn: true },
      ]}
      columns={[
        { key: "rider", label: "Rider", render: (r) => (
          <div>
            <div className="text-sm font-semibold text-slate-900">{r.rider}</div>
            {r.phone && <div className="text-xs text-slate-500">{r.phone}</div>}
          </div>
        ) },
        { key: "codOrders", label: "COD Orders", align: "right" },
        { key: "collected", label: "Collected", align: "right", money: true, className: "font-medium text-slate-900" },
        { key: "settled", label: "Settled", align: "right", money: true, className: "text-emerald-700" },
        { key: "outstanding", label: "Outstanding", align: "right", money: true, className: "text-red-600" },
      ]}
      footer={(s) => ["Total", s.codOrders, inr(s.collected), inr(s.settled), inr(s.outstanding)]}
    />
  )
}
