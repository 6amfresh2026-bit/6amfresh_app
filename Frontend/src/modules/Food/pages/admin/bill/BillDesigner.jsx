import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2, ReceiptText, Download, RotateCcw, Save } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"
import { RECEIPT_CSS, receiptBody, receiptClasses, receiptDoc } from "./receiptTemplate"

/**
 * Bill designer — lay out the POS receipt with a live preview.
 *
 * Every control on the left writes into one `config` object; the preview on the
 * right is rebuilt from it on each keystroke by the shared receipt template, so
 * the paper always shows exactly what will print. Saving stores the config
 * against the chosen store (or the all-stores default), which the POS reads back
 * for its next bill.
 */

const PRESETS = {
  classic: {
    preset: "classic", textSize: "normal", dividers: "dashed", font: "mono", headingAlign: "center", boldTotal: true,
    showStoreName: true, showStoreAddress: true, showStorePhone: true,
    showBillNo: true, showDateTime: true, showCashier: true, showCustomerName: true, showCustomerPhone: true, showTable: true, showPackSize: true,
    showItemsQty: true, showTotalMrp: true, showYouSaved: true, showGstTable: true, showGstIncluded: true, showPayment: true, showLoyalty: true,
    showBarcode: true,
  },
  compact: {
    preset: "compact", textSize: "small", dividers: "dashed",
    showCustomerPhone: false, showTable: false, showPackSize: false,
    showTotalMrp: false, showGstTable: false, showLoyalty: false, showBarcode: true,
  },
  minimal: {
    preset: "minimal", textSize: "normal", dividers: "none",
    showCashier: false, showCustomerName: false, showCustomerPhone: false, showTable: false, showPackSize: false,
    showTotalMrp: false, showYouSaved: false, showGstTable: false, showGstIncluded: false, showLoyalty: false, showBarcode: false,
  },
  detailed: {
    preset: "detailed", textSize: "normal", dividers: "solid", boldTotal: true,
    showStoreName: true, showStoreAddress: true, showStorePhone: true,
    showBillNo: true, showDateTime: true, showCashier: true, showCustomerName: true, showCustomerPhone: true, showTable: true, showPackSize: true,
    showItemsQty: true, showTotalMrp: true, showYouSaved: true, showGstTable: true, showGstIncluded: true, showPayment: true, showLoyalty: true,
    showBarcode: true,
  },
}

const today = () => new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })

export default function BillDesigner() {
  const [stores, setStores] = useState([])
  const [storeId, setStoreId] = useState("") // "" = all-stores default
  const [config, setConfig] = useState(PRESETS.classic)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const logoInput = useRef(null)

  useEffect(() => {
    ;(async () => {
      try {
        const r = await adminAPI.getRestaurants({ limit: 1000 })
        setStores(r?.data?.data?.restaurants || r?.data?.restaurants || [])
      } catch {
        /* store picker degrades to default only */
      }
    })()
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminAPI.getBillDesign(storeId ? { restaurantId: storeId } : {})
      setConfig({ ...PRESETS.classic, ...(res?.data?.data?.config || {}) })
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to load design")
    } finally {
      setLoading(false)
    }
  }, [storeId])

  useEffect(() => {
    load()
  }, [load])

  const set = (key, value) => setConfig((c) => ({ ...c, [key]: value }))
  const applyPreset = (name) => setConfig((c) => ({ ...c, ...PRESETS[name] }))

  const onLogo = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 500 * 1024) return toast.error("Logo should be under 500 KB")
    const reader = new FileReader()
    reader.onload = () => set("logoUrl", String(reader.result || ""))
    reader.readAsDataURL(file)
  }

  const save = async () => {
    setSaving(true)
    try {
      await adminAPI.saveBillDesign({ ...(storeId ? { restaurantId: storeId } : {}), config })
      toast.success(storeId ? "Saved for this store" : "Saved as the default")
    } catch (error) {
      toast.error(error?.response?.data?.message || "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const downloadTest = () => {
    const w = window.open("", "_blank", "width=420,height=720")
    if (!w) return toast.error("Allow pop-ups to open the test bill")
    w.document.open()
    w.document.write(receiptDoc(config))
    w.document.close()
  }

  const previewHtml = useMemo(() => receiptBody(config), [config])
  const previewClass = useMemo(() => receiptClasses(config), [config])

  return (
    <div className="min-h-screen bg-neutral-50 p-4 text-neutral-700 md:p-6">
      <style>{RECEIPT_CSS}</style>

      {/* Header */}
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-neutral-900">Bill designer</h1>
        <p className="mt-1 text-sm text-neutral-500">Design the receipt printed at the POS counter · {today()}</p>
      </div>

      {/* Top bar */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="text-sm text-neutral-500">Apply to</span>
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className="h-10 rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-800 outline-none focus:border-primary">
            <option value="">All stores (default)</option>
            {stores.map((s) => (
              <option key={s._id || s.id} value={s._id || s.id}>{s.restaurantName || s.name}</option>
            ))}
          </select>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-neutral-500">Start from</span>
          {["classic", "compact", "minimal", "detailed"].map((p) => (
            <button key={p} onClick={() => applyPreset(p)} className={`h-9 rounded-full border px-3 text-sm font-medium capitalize ${config.preset === p ? "border-primary bg-primary/10 text-primary" : "border-neutral-300 text-neutral-700 hover:border-primary hover:text-primary"}`}>
              {p}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex h-60 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-neutral-300" /></div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* ───────────── Left: controls ───────────── */}
          <div className="space-y-4">
            {/* 1 · Paper and style */}
            <Section title="1 · Paper and style">
              <Field label="Paper width">
                <Seg value={config.paperWidth} onChange={(v) => set("paperWidth", v)} options={[["pos", "POS setting"], ["80", "80 mm"], ["58", "58 mm"]]} />
              </Field>
              <Field label="Text size">
                <Seg value={config.textSize} onChange={(v) => set("textSize", v)} options={[["small", "Small"], ["normal", "Normal"], ["large", "Large"]]} />
              </Field>
              <Field label="Font">
                <Seg value={config.font} onChange={(v) => set("font", v)} options={[["mono", "Receipt (monospace)"], ["sans", "Clean (sans-serif)"]]} />
              </Field>
              <Field label="Divider lines">
                <Seg value={config.dividers} onChange={(v) => set("dividers", v)} options={[["dashed", "Dashed"], ["solid", "Solid"], ["none", "None"]]} />
              </Field>
              <Field label="Heading alignment">
                <Seg value={config.headingAlign} onChange={(v) => set("headingAlign", v)} options={[["center", "Centre"], ["left", "Left"]]} />
              </Field>
              <Check checked={config.boldTotal} onChange={(v) => set("boldTotal", v)}>Bold, large total</Check>
            </Section>

            {/* 2 · Header */}
            <Section title="2 · Header">
              <Field label="Logo (printed above the name)">
                <div className="flex flex-wrap items-center gap-2">
                  <input ref={logoInput} type="file" accept="image/*" onChange={onLogo} className="text-sm text-neutral-600 file:mr-2 file:rounded-md file:border file:border-neutral-300 file:bg-white file:px-3 file:py-1.5 file:text-sm" />
                  {config.logoUrl && (
                    <button onClick={() => { set("logoUrl", ""); if (logoInput.current) logoInput.current.value = "" }} className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50">Remove logo</button>
                  )}
                  <label className="flex items-center gap-1 text-sm text-neutral-500">Height
                    <input type="number" min={16} max={120} value={config.logoHeight} onChange={(e) => set("logoHeight", Number(e.target.value))} className="h-9 w-20 rounded-lg border border-neutral-300 px-2 text-sm text-neutral-900 outline-none focus:border-primary" /> px
                  </label>
                </div>
                <p className="mt-1 text-xs text-neutral-400">Black-and-white logos print best on thermal paper.</p>
              </Field>
              <Text label="Business name" value={config.businessName} onChange={(v) => set("businessName", v)} placeholder="6AM FRESH" />
              <Text label="Line under the name" value={config.tagline} onChange={(v) => set("tagline", v)} placeholder="start fresh. stay fresh" />
              <Text label="Bill title" value={config.billTitle} onChange={(v) => set("billTitle", v)} placeholder="TAX INVOICE" />
              <Text label="GSTIN (leave empty to use the POS setting)" value={config.gstin} onChange={(v) => set("gstin", v)} placeholder="e.g. 23ABCDE1234F1Z5" />
              <Area label="Extra header lines" value={config.extraHeader} onChange={(v) => set("extraHeader", v)} placeholder="e.g. FSSAI Lic. 1234567890" />
              <div className="flex flex-wrap gap-x-8 gap-y-2 pt-1">
                <Check checked={config.showStoreName} onChange={(v) => set("showStoreName", v)}>Store name</Check>
                <Check checked={config.showStoreAddress} onChange={(v) => set("showStoreAddress", v)}>Store address</Check>
                <Check checked={config.showStorePhone} onChange={(v) => set("showStorePhone", v)}>Store phone</Check>
              </div>
            </Section>

            {/* 3 · Bill details */}
            <Section title="3 · Bill details">
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
                <Check checked={config.showBillNo} onChange={(v) => set("showBillNo", v)}>Bill number</Check>
                <Check checked={config.showDateTime} onChange={(v) => set("showDateTime", v)}>Date and time</Check>
                <Check checked={config.showCashier} onChange={(v) => set("showCashier", v)}>Cashier name</Check>
                <Check checked={config.showCustomerName} onChange={(v) => set("showCustomerName", v)}>Customer name</Check>
                <Check checked={config.showCustomerPhone} onChange={(v) => set("showCustomerPhone", v)}>Customer phone</Check>
                <Check checked={config.showTable} onChange={(v) => set("showTable", v)}>Table / token</Check>
                <Check checked={config.showPackSize} onChange={(v) => set("showPackSize", v)}>Pack size on items</Check>
              </div>
            </Section>

            {/* 4 · Totals and payment */}
            <Section title="4 · Totals and payment">
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
                <Check checked={config.showItemsQty} onChange={(v) => set("showItemsQty", v)}>Items / quantity</Check>
                <Check checked={config.showTotalMrp} onChange={(v) => set("showTotalMrp", v)}>Total MRP</Check>
                <Check checked={config.showYouSaved} onChange={(v) => set("showYouSaved", v)}>You saved</Check>
                <Check checked={config.showGstTable} onChange={(v) => set("showGstTable", v)}>GST table (CGST / SGST)</Check>
                <Check checked={config.showGstIncluded} onChange={(v) => set("showGstIncluded", v)}>&quot;GST included&quot; line</Check>
                <Check checked={config.showPayment} onChange={(v) => set("showPayment", v)}>Payment lines</Check>
                <Check checked={config.showLoyalty} onChange={(v) => set("showLoyalty", v)}>Loyalty points earned</Check>
              </div>
            </Section>

            {/* 5 · Footer */}
            <Section title="5 · Footer">
              <Area label="Thank-you message" value={config.thankYou} onChange={(v) => set("thankYou", v)} placeholder="e.g. Thank you for shopping with 6am fresh!" />
              <Area label="Extra note (offers, helpline)" value={config.extraNote} onChange={(v) => set("extraNote", v)} placeholder="e.g. Helpline 1800-000-000" />
              <Area label="Terms line" value={config.termsLine} onChange={(v) => set("termsLine", v)} placeholder="Prices include GST · Goods once sold can be returned with this bill" />
              <Check checked={config.showBarcode} onChange={(v) => set("showBarcode", v)}>Barcode of the bill number</Check>
            </Section>

            {/* Actions */}
            <div className="flex flex-wrap items-center justify-end gap-2 pb-6">
              <button onClick={() => applyPreset("classic")} className="inline-flex h-10 items-center gap-2 rounded-full border border-neutral-300 px-4 text-sm font-medium text-neutral-700 hover:border-primary hover:text-primary">
                <RotateCcw className="h-4 w-4" /> Reset to classic
              </button>
              <button onClick={downloadTest} className="inline-flex h-10 items-center gap-2 rounded-full border border-neutral-300 px-4 text-sm font-medium text-neutral-700 hover:border-primary hover:text-primary">
                <Download className="h-4 w-4" /> Download test bill
              </button>
              <button onClick={save} disabled={saving} className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-50">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save design
              </button>
            </div>
          </div>

          {/* ───────────── Right: live preview ───────────── */}
          <div className="lg:sticky lg:top-4 lg:self-start">
            <div className="rounded-2xl border border-neutral-200 bg-neutral-100 p-4 shadow-sm">
              <div className="mb-2 flex items-center justify-between text-xs text-neutral-500">
                <span className="inline-flex items-center gap-1"><ReceiptText className="h-3.5 w-3.5" /> Live preview</span>
                <span>{config.paperWidth === "58" ? "58 mm paper" : "80 mm paper"}</span>
              </div>
              <div className="max-h-[78vh] overflow-y-auto rounded-lg bg-neutral-200 p-4">
                <div className={previewClass} dangerouslySetInnerHTML={{ __html: previewHtml }} />
              </div>
              <p className="mt-2 text-xs text-neutral-400">Sample bill with sample items. Your store details come from Stores.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-5">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-neutral-800">{title}</h2>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <div className="mb-1.5 text-sm font-medium text-neutral-600">{label}</div>
      {children}
    </div>
  )
}

function Seg({ value, onChange, options }) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-lg border border-neutral-200 bg-neutral-50 p-1">
      {options.map(([val, label]) => (
        <button
          key={val}
          type="button"
          onClick={() => onChange(val)}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${value === val ? "bg-primary text-white shadow-sm" : "text-neutral-600 hover:bg-white"}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function Text({ label, value, onChange, placeholder }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-neutral-600">{label}</span>
      <input value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-10 w-full rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-900 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
    </label>
  )
}

function Area({ label, value, onChange, placeholder }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-neutral-600">{label}</span>
      <textarea value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={2} className="w-full resize-y rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
    </label>
  )
}

function Check({ checked, onChange, children }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[color:var(--module-theme,#10b981)]" />
      {children}
    </label>
  )
}
