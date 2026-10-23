import { useMemo, useState } from "react"
import { Loader2, Download, X, CheckCircle2, AlertTriangle, FileUp } from "lucide-react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"

/**
 * Bulk import — add products, update prices, and load opening stock from a
 * spreadsheet. The CSV is parsed here in the browser and sent as JSON rows; the
 * server matches each row (barcode, then SKU, then name + size) and tells us
 * what would change before anything is written. "Check data" is the dry run;
 * only "Import" commits.
 */

const HEADERS = ["name", "size", "category", "subcategory", "brand", "sku", "barcode", "mrp", "price", "cost", "gst", "supplier", "store", "stock", "min_stock"]
const SAMPLE = [
  "Basmati Rice,5 kg,Staples,Rice & flour,India Gate,SF-0001,,560,520,442,0,Acme Foods,,24,20",
  "Toor Dal,1 kg,Staples,Pulses,Tata,SF-0002,,180,165,136,0,,,30,20",
]

// A small CSV parser that honours quoted fields (commas and newlines inside quotes).
function parseCsv(text) {
  const rows = []; let field = "", row = [], inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false }
      else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ",") { row.push(field); field = "" }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = "" }
    else if (c !== "\r") field += c
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""))
}
function toObjects(text) {
  const rows = parseCsv(text)
  if (rows.length < 2) return []
  const headers = rows[0].map((h) => h.trim())
  return rows.slice(1).map((r) => { const o = {}; headers.forEach((h, idx) => { o[h] = r[idx] ?? "" }); return o })
}
function download(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}
const csvCell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

export default function BulkImportModal({ stores = [], onClose, onDone }) {
  const [storeId, setStoreId] = useState(stores[0]?._id || stores[0]?.id || "")
  const [csv, setCsv] = useState("")
  const [checking, setChecking] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [check, setCheck] = useState(null)   // { rows, summary }
  const [loadingCurrent, setLoadingCurrent] = useState(false)

  const rows = useMemo(() => toObjects(csv), [csv])

  const onFile = (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => { setCsv(String(reader.result || "")); setCheck(null) }
    reader.readAsText(f)
  }

  const getTemplate = () => download("bulk-import-template.csv", [HEADERS.join(","), ...SAMPLE].join("\n"))

  const getCurrent = async () => {
    setLoadingCurrent(true)
    try {
      const res = await adminAPI.getStocks({ limit: 1000, ...(storeId ? { restaurantId: storeId } : {}) })
      const items = res?.data?.data?.stocks || []
      const lines = items.map((it) => [
        it.name, it.unitName || "", it.categoryName || "", "", it.brandName || "",
        it.itemCode || "", "", it.mrp ?? "", it.sellingPrice ?? "", it.purchasePrice ?? "", "",
        "", it.restaurantName || "", it.stockQty ?? "", it.lowStockThreshold ?? "",
      ].map(csvCell).join(","))
      download("current-inventory.csv", [HEADERS.join(","), ...lines].join("\n"))
    } catch {
      toast.error("Could not export current inventory")
    } finally {
      setLoadingCurrent(false)
    }
  }

  const runCheck = async () => {
    if (!rows.length) { toast.error("Add some rows first"); return }
    setChecking(true); setCheck(null)
    try {
      const res = await adminAPI.bulkImportStockCheck({ rows, storeId })
      setCheck(res?.data?.data || null)
    } catch (e) {
      toast.error(e?.response?.data?.message || "Check failed")
    } finally {
      setChecking(false)
    }
  }

  const runCommit = async () => {
    setCommitting(true)
    try {
      const res = await adminAPI.bulkImportStockCommit({ rows, storeId })
      const s = res?.data?.data?.summary || {}
      toast.success(`Imported — ${s.created || 0} created, ${s.updated || 0} updated`)
      onDone?.()
      onClose?.()
    } catch (e) {
      toast.error(e?.response?.data?.message || "Import failed")
    } finally {
      setCommitting(false)
    }
  }

  const s = check?.summary
  const canImport = s && (s.creates > 0 || s.updates > 0)

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onMouseDown={onClose}>
      <div className="my-6 w-full max-w-4xl rounded-lg bg-white shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-neutral-900">Bulk import</h2>
            <p className="text-sm text-neutral-500">Add products, update prices and load stock from a spreadsheet. Nothing changes until you press Import.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-neutral-400 hover:bg-neutral-100"><X className="h-5 w-5" /></button>
        </div>

        <div className="grid gap-4 p-5 md:grid-cols-3">
          {/* 1 — layout */}
          <div className="rounded-lg border border-neutral-200 p-4">
            <div className="text-sm font-semibold text-neutral-900">1 · Get the layout</div>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500">Columns: {HEADERS.join(", ")}. Existing products are matched by barcode, then SKU, then name + size.</p>
            <div className="mt-3 flex flex-col gap-2">
              <button type="button" onClick={getTemplate} className="inline-flex items-center justify-center gap-1.5 rounded-full border border-emerald-500 px-3 py-1.5 text-sm font-medium text-emerald-600 hover:bg-emerald-50"><Download className="h-4 w-4" /> Template (CSV)</button>
              <button type="button" onClick={getCurrent} disabled={loadingCurrent} className="inline-flex items-center justify-center gap-1.5 rounded-full border border-emerald-500 px-3 py-1.5 text-sm font-medium text-emerald-600 hover:bg-emerald-50 disabled:opacity-50">{loadingCurrent ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Current inventory (CSV)</button>
            </div>
          </div>

          {/* 2 — store */}
          <div className="rounded-lg border border-neutral-200 p-4">
            <div className="text-sm font-semibold text-neutral-900">2 · Stock goes to</div>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500">Used when a row has no <span className="font-medium">store</span> column. The stock value is the quantity <span className="font-medium">on hand</span> — it replaces the current number.</p>
            <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className="mt-3 h-10 w-full rounded border border-neutral-300 bg-white px-2 text-sm">
              <option value="">— pick a store —</option>
              {stores.map((st) => <option key={st._id || st.id} value={st._id || st.id}>{st.restaurantName || st.name}</option>)}
            </select>
          </div>

          {/* 3 — file */}
          <div className="rounded-lg border border-neutral-200 p-4">
            <div className="text-sm font-semibold text-neutral-900">3 · Add your file</div>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500">Choose a CSV file, or paste the rows below.</p>
            <label className="mt-3 flex cursor-pointer items-center gap-2 rounded border border-dashed border-neutral-300 px-3 py-2.5 text-sm text-neutral-600 hover:bg-neutral-50">
              <FileUp className="h-4 w-4 text-neutral-400" />
              <span className="truncate">Choose CSV file</span>
              <input type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
            </label>
          </div>
        </div>

        <div className="px-5 pb-2">
          <textarea
            value={csv}
            onChange={(e) => { setCsv(e.target.value); setCheck(null) }}
            placeholder="…or paste CSV rows here, including the header row"
            className="h-28 w-full resize-y rounded border border-neutral-300 p-3 font-mono text-xs outline-none focus:border-emerald-400"
          />
          {rows.length > 0 && <div className="mt-1 text-xs text-neutral-400">{rows.length} data row{rows.length === 1 ? "" : "s"} detected</div>}
        </div>

        {/* preview */}
        {check && (
          <div className="mx-5 mb-3 rounded-lg border border-neutral-200">
            <div className="flex flex-wrap items-center gap-3 border-b bg-neutral-50 px-4 py-2.5 text-sm">
              <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700"><CheckCircle2 className="h-4 w-4" /> {s.creates} to create</span>
              <span className="inline-flex items-center gap-1.5 font-medium text-sky-700"><CheckCircle2 className="h-4 w-4" /> {s.updates} to update</span>
              {s.errors > 0 && <span className="inline-flex items-center gap-1.5 font-medium text-red-600"><AlertTriangle className="h-4 w-4" /> {s.errors} with problems</span>}
            </div>
            <div className="max-h-56 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white text-left text-xs uppercase tracking-wide text-neutral-500">
                  <tr><th className="px-4 py-2 font-medium">#</th><th className="px-4 py-2 font-medium">Product</th><th className="px-4 py-2 font-medium">Store</th><th className="px-4 py-2 font-medium">Action</th><th className="px-4 py-2 font-medium">Details</th></tr>
                </thead>
                <tbody>
                  {check.rows.map((r) => (
                    <tr key={r.line} className="border-t border-neutral-100">
                      <td className="px-4 py-1.5 text-neutral-400">{r.line}</td>
                      <td className="px-4 py-1.5 font-medium text-neutral-800">{r.name || "—"}</td>
                      <td className="px-4 py-1.5 text-neutral-600">{r.store || "—"}</td>
                      <td className="px-4 py-1.5">
                        {r.action === "create" ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">Create</span>
                          : r.action === "update" ? <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">Update</span>
                          : <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">Error</span>}
                      </td>
                      <td className="px-4 py-1.5 text-xs text-neutral-500">{r.action === "error" ? r.message : r.action === "update" ? (r.changes?.length ? `by ${r.matchedBy} · ${r.changes.join(", ")}` : `by ${r.matchedBy} · no change`) : "new product"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t px-5 py-4">
          <button type="button" onClick={runCheck} disabled={checking || !rows.length} className="inline-flex items-center gap-2 rounded-full bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
            {checking && <Loader2 className="h-4 w-4 animate-spin" />} Check data
          </button>
          <button type="button" onClick={runCommit} disabled={!canImport || committing} className="inline-flex items-center gap-2 rounded-full bg-neutral-900 px-5 py-2 text-sm font-semibold text-white hover:bg-black disabled:opacity-40">
            {committing && <Loader2 className="h-4 w-4 animate-spin" />} Import{s ? ` ${s.creates + s.updates} product${s.creates + s.updates === 1 ? "" : "s"}` : ""}
          </button>
        </div>
      </div>
    </div>
  )
}
