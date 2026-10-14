import { Package } from "lucide-react"
import { adminAPI } from "@food/api"
import DataReport, { inr } from "./DataReport"

export default function ProductReport() {
  return (
    <DataReport
      title="Product report"
      description="Units sold and revenue per product, with live stock. Cancelled orders are excluded."
      icon={Package}
      csvName="product-report"
      rowKey={(r) => r.itemId || r.product}
      fetchReport={async (params) => {
        const res = await adminAPI.getProductReport(params)
        const d = res?.data?.data
        return { rows: d?.products || [], summary: d?.summary || null }
      }}
      tiles={[
        { label: "Products", key: "products" },
        { label: "Units Sold", key: "units" },
        { label: "Revenue", key: "revenue", money: true },
        { label: "Cost", key: "cost", money: true },
        { label: "Margin", key: "margin", money: true },
      ]}
      columns={[
        { key: "product", label: "Product", render: (r) => (
          <div>
            <div className="text-sm font-semibold text-slate-900">{r.product}</div>
            {(r.sku || r.category) && <div className="text-xs text-slate-500">{[r.sku, r.category].filter(Boolean).join(" · ")}</div>}
          </div>
        ) },
        { key: "units", label: "Units", align: "right" },
        { key: "revenue", label: "Revenue", align: "right", money: true },
        { key: "cost", label: "Cost", align: "right", money: true },
        { key: "margin", label: "Margin", align: "right", money: true, className: "font-medium text-emerald-700" },
        { key: "stock", label: "Stock", align: "right", render: (r) => r.stock == null ? <span className="text-slate-400">∞</span> : r.stock },
      ]}
      footer={(s) => ["Total", s.units, inr(s.revenue), inr(s.cost), inr(s.margin), ""]}
    />
  )
}
