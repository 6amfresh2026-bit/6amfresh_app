import { PiggyBank } from "lucide-react"
import { adminAPI } from "@food/api"
import DataReport, { inr } from "./DataReport"

export default function StoreProfit() {
  return (
    <DataReport
      title="Store-wise profit"
      description="Revenue, commission, store payout and net platform profit per store, from the transaction ledger."
      icon={PiggyBank}
      csvName="store-wise-profit"
      showZone
      showSeller
      rowKey={(r) => r.storeId}
      fetchReport={async (params) => {
        const res = await adminAPI.getStoreProfitReport(params)
        const d = res?.data?.data
        return { rows: d?.stores || [], summary: d?.summary || null }
      }}
      tiles={[
        { label: "Stores", key: "stores" },
        { label: "Orders", key: "orders" },
        { label: "Revenue", key: "revenue", money: true },
        { label: "Commission", key: "commission", money: true },
        { label: "Net Profit", key: "netProfit", money: true },
      ]}
      columns={[
        { key: "store", label: "Store", render: (r) => (
          <div className="text-sm font-semibold text-slate-900">{r.store}</div>
        ) },
        { key: "orders", label: "Orders", align: "right" },
        { key: "revenue", label: "Revenue", align: "right", money: true, className: "font-medium text-slate-900" },
        { key: "commission", label: "Commission", align: "right", money: true },
        { key: "storePayout", label: "Store Payout", align: "right", money: true },
        { key: "netProfit", label: "Net Profit", align: "right", money: true, className: "font-medium text-emerald-700" },
      ]}
      footer={(s) => ["Total", s.orders, inr(s.revenue), inr(s.commission), inr(s.storePayout), inr(s.netProfit)]}
    />
  )
}
