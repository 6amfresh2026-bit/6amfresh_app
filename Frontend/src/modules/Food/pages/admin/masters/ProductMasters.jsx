import { useCallback, useEffect, useState } from "react"
import { useLocation } from "react-router-dom"
import { Loader2, Pencil, Plus, Search, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@food/components/ui/dialog"
import { canCurrentAdminAction } from "@food/utils/adminRbac"

/**
 * Product master data — brands (and sub-brands), units of measurement, and
 * departments — laid out the way the reference ERP (vasy) lays them out: each
 * one is its own screen under Items, reached from its own sidebar entry. The
 * three screens share this component because they are the same screen with a
 * different column set; the `tab` prop (or the route) picks which.
 *
 * Every screen is the same vasy list shape: toolbar with search / page size /
 * Create New, a striped table with a Sr. No. column and an ACTIVE badge, and a
 * "···" actions cell.
 */

const TAB_BY_PATH = {
  "/admin/store/brands": "brands",
  "/admin/store/units": "units",
  "/admin/store/departments": "departments",
}

const emptyBrand = { name: "", parentId: "", description: "", isActive: true, sortOrder: 0 }
const emptyUnit = { name: "", shortName: "", decimalPlaces: 0, baseUnitId: "", conversionFactor: "", isActive: true, sortOrder: 0 }
const emptyDepartment = { name: "", code: "", description: "", isActive: true, sortOrder: 0 }

const TABS = {
  brands: {
    title: "Brand",
    label: "Brands",
    singular: "Brand",
    listKey: "brands",
    emptyForm: emptyBrand,
    list: (params) => adminAPI.getBrands(params),
    create: (body) => adminAPI.createBrand(body),
    update: (id, body) => adminAPI.updateBrand(id, body),
    toggle: (id) => adminAPI.toggleBrandStatus(id),
    remove: (id) => adminAPI.deleteBrand(id),
    columns: [
      { key: "name", label: "Name" },
      { key: "parentName", label: "Parent Brand", render: (r) => r.parentName || "—" },
      { key: "description", label: "Description", render: (r) => r.description || "—" },
    ],
  },
  units: {
    title: "Unit Of Measurement",
    label: "Units of Measurement",
    singular: "Unit",
    listKey: "units",
    emptyForm: emptyUnit,
    list: (params) => adminAPI.getUnits(params),
    create: (body) => adminAPI.createUnit(body),
    update: (id, body) => adminAPI.updateUnit(id, body),
    toggle: (id) => adminAPI.toggleUnitStatus(id),
    remove: (id) => adminAPI.deleteUnit(id),
    columns: [
      { key: "name", label: "Name" },
      { key: "shortName", label: "Short Name" },
      { key: "decimalPlaces", label: "Decimals" },
      { key: "conversionLabel", label: "Conversion", render: (r) => r.conversionLabel || "Base unit" },
    ],
  },
  departments: {
    title: "Department",
    label: "Departments",
    singular: "Department",
    listKey: "departments",
    emptyForm: emptyDepartment,
    list: (params) => adminAPI.getDepartments(params),
    create: (body) => adminAPI.createDepartment(body),
    update: (id, body) => adminAPI.updateDepartment(id, body),
    toggle: (id) => adminAPI.toggleDepartmentStatus(id),
    remove: (id) => adminAPI.deleteDepartment(id),
    columns: [
      { key: "name", label: "Name" },
      { key: "code", label: "Code", render: (r) => r.code || "—" },
      { key: "description", label: "Description", render: (r) => r.description || "—" },
    ],
  },
}

const Field = ({ label, required, hint, children }) => (
  <label className="block">
    <span className="mb-1 block text-sm font-medium text-neutral-800">
      {label}
      {required && <span className="text-rose-500">*</span>}
    </span>
    {children}
    {hint && <span className="mt-1 block text-xs text-sky-600">{hint}</span>}
  </label>
)

const inputClass =
  "w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-sky-500"

/** vasy list toolbar + table, for one master. `embedded` hides the page header (used inside Category / Brand). */
export default function ProductMasters({ tab: forcedTab, embedded = false }) {
  const location = useLocation()
  const tabId = forcedTab || TAB_BY_PATH[location.pathname] || "brands"
  const tab = TABS[tabId]

  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(tab.emptyForm)
  const [saving, setSaving] = useState(false)
  const [menuFor, setMenuFor] = useState(null)

  const [brandOptions, setBrandOptions] = useState([])
  const [unitOptions, setUnitOptions] = useState([])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const rbacPath = `/admin/store/${tabId}`
  const canEdit = canCurrentAdminAction("edit", rbacPath)
  const canCreate = canCurrentAdminAction("create", rbacPath)
  const canDelete = canCurrentAdminAction("delete", rbacPath)

  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPage(1)
    }, 300)
    return () => window.clearTimeout(id)
  }, [search])

  useEffect(() => {
    setSearch("")
    setDebouncedSearch("")
    setPage(1)
  }, [tabId])

  const fetchRows = useCallback(async () => {
    setLoading(true)
    try {
      const params = { page, limit: pageSize }
      if (debouncedSearch) params.search = debouncedSearch
      const res = await tab.list(params)
      const data = res?.data?.data || {}
      setRows(data[tab.listKey] || [])
      setTotal(Number(data.total) || 0)
    } catch (error) {
      toast.error(error?.response?.data?.message || `Failed to load ${tab.label.toLowerCase()}`)
      setRows([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [tab, page, pageSize, debouncedSearch])

  useEffect(() => {
    fetchRows()
  }, [fetchRows])

  useEffect(() => {
    if (!dialogOpen) return
    let cancelled = false
    const load = async () => {
      try {
        if (tabId === "brands") {
          const res = await adminAPI.getBrands({ parentId: "none", limit: 200 })
          if (!cancelled) setBrandOptions(res?.data?.data?.brands || [])
        } else if (tabId === "units") {
          const res = await adminAPI.getUnits({ baseOnly: "true", limit: 200 })
          if (!cancelled) setUnitOptions(res?.data?.data?.units || [])
        }
      } catch {
        /* picker failure leaves the field empty; the record still saves */
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [dialogOpen, tabId])

  const openCreate = () => {
    setEditing(null)
    setForm(tab.emptyForm)
    setDialogOpen(true)
  }

  const openEdit = (row) => {
    setEditing(row)
    setMenuFor(null)
    if (tabId === "brands") {
      setForm({ name: row.name || "", parentId: row.parentId || "", description: row.description || "", isActive: row.isActive, sortOrder: row.sortOrder || 0 })
    } else if (tabId === "units") {
      setForm({ name: row.name || "", shortName: row.shortName || "", decimalPlaces: row.decimalPlaces ?? 0, baseUnitId: row.baseUnitId || "", conversionFactor: row.conversionFactor ?? "", isActive: row.isActive, sortOrder: row.sortOrder || 0 })
    } else {
      setForm({ name: row.name || "", code: row.code || "", description: row.description || "", isActive: row.isActive, sortOrder: row.sortOrder || 0 })
    }
    setDialogOpen(true)
  }

  const buildPayload = () => {
    const base = { ...form, sortOrder: Number(form.sortOrder) || 0 }
    if (tabId === "units") {
      base.decimalPlaces = Number(form.decimalPlaces) || 0
      if (!form.baseUnitId) {
        base.baseUnitId = ""
        base.conversionFactor = null
      } else {
        base.conversionFactor = Number(form.conversionFactor)
      }
    }
    if (tabId === "brands" && !form.parentId) base.parentId = ""
    return base
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!String(form.name || "").trim()) {
      toast.error(`${tab.singular} name is required`)
      return
    }
    setSaving(true)
    try {
      const payload = buildPayload()
      if (editing) {
        await tab.update(editing.id, payload)
        toast.success(`${tab.singular} updated`)
      } else {
        await tab.create(payload)
        toast.success(`${tab.singular} created`)
      }
      setDialogOpen(false)
      await fetchRows()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const onToggle = async (row) => {
    try {
      await tab.toggle(row.id)
      await fetchRows()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not change status")
    }
  }

  const onDelete = async (row) => {
    setMenuFor(null)
    if (!window.confirm(`Delete ${tab.singular.toLowerCase()} "${row.name}"?`)) return
    try {
      await tab.remove(row.id)
      toast.success(`${tab.singular} deleted`)
      await fetchRows()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Delete failed")
    }
  }

  return (
    <div className={embedded ? "" : "p-4 sm:p-6"}>
      {!embedded && (
        <div className="mb-4 flex items-center gap-2 text-lg">
          <span className="font-semibold text-neutral-900">{tab.title}</span>
          <span className="text-neutral-300">|</span>
          <span className="text-neutral-400">⌂</span>
        </div>
      )}

      <div className="rounded-md border border-neutral-200 bg-white p-4 shadow-sm">
        {/* vasy toolbar */}
        <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value))
              setPage(1)
            }}
            className="h-9 rounded border border-neutral-300 bg-white px-2 text-sm"
          >
            {[10, 25, 50].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <div className="relative">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search List..."
              className="h-9 w-56 rounded border border-neutral-300 bg-white pl-3 pr-8 text-sm outline-none focus:border-sky-500"
            />
            <Search className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          </div>
          {canCreate && (
            <button
              type="button"
              onClick={openCreate}
              className="h-9 rounded bg-sky-500 px-4 text-sm font-medium text-white hover:bg-sky-600"
            >
              Create New
            </button>
          )}
        </div>

        {/* vasy table */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-neutral-100 text-left text-neutral-800">
              <tr>
                <th className="w-8 px-3 py-3"><input type="checkbox" disabled className="rounded border-neutral-300" /></th>
                <th className="px-3 py-3 font-semibold">Sr. No.</th>
                {tab.columns.map((c) => (
                  <th key={c.key} className="px-3 py-3 font-semibold">{c.label}</th>
                ))}
                <th className="px-3 py-3 font-semibold">Status</th>
                <th className="px-3 py-3 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={tab.columns.length + 4} className="px-3 py-14 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-neutral-400" /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={tab.columns.length + 4} className="px-3 py-14 text-center text-neutral-500">No {tab.label.toLowerCase()} yet.</td></tr>
              ) : (
                rows.map((row, i) => (
                  <tr key={row.id} className="border-t border-neutral-100 odd:bg-white even:bg-neutral-50/60">
                    <td className="px-3 py-3"><input type="checkbox" className="rounded border-neutral-300" /></td>
                    <td className="px-3 py-3 text-sky-600">{(page - 1) * pageSize + i + 1}</td>
                    {tab.columns.map((c, ci) => (
                      <td key={c.key} className={`px-3 py-3 ${ci === 0 ? "font-medium text-sky-600" : "text-neutral-700"}`}>
                        {c.render ? c.render(row) : row[c.key]}
                      </td>
                    ))}
                    <td className="px-3 py-3">
                      <button
                        type="button"
                        disabled={!canEdit}
                        onClick={() => onToggle(row)}
                        className={`rounded px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-white ${row.isActive ? "bg-emerald-500" : "bg-neutral-400"}`}
                      >
                        {row.isActive ? "Active" : "Inactive"}
                      </button>
                    </td>
                    <td className="relative px-3 py-3">
                      <button
                        type="button"
                        onClick={() => setMenuFor(menuFor === row.id ? null : row.id)}
                        className="px-2 text-lg leading-none text-neutral-500 hover:text-neutral-800"
                        aria-label="Actions"
                      >
                        ···
                      </button>
                      {menuFor === row.id && (
                        <div className="absolute right-2 z-10 mt-1 w-32 rounded border border-neutral-200 bg-white py-1 text-sm shadow-lg">
                          {canEdit && (
                            <button type="button" onClick={() => openEdit(row)} className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-neutral-50">
                              <Pencil className="h-3.5 w-3.5" /> Edit
                            </button>
                          )}
                          {canDelete && (
                            <button type="button" onClick={() => onDelete(row)} className="flex w-full items-center gap-2 px-3 py-1.5 text-rose-600 hover:bg-rose-50">
                              <Trash2 className="h-3.5 w-3.5" /> Delete
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center justify-between text-sm text-neutral-600">
          <span>Showing {rows.length ? (page - 1) * pageSize + 1 : 0} to {(page - 1) * pageSize + rows.length} of {total}</span>
          <div className="flex items-center gap-2">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border border-neutral-300 px-3 py-1 disabled:opacity-40">Prev</button>
            <span>{page} / {totalPages}</span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded border border-neutral-300 px-3 py-1 disabled:opacity-40">Next</button>
          </div>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto p-5 sm:max-w-lg sm:p-6">
          <DialogHeader>
            <DialogTitle className="text-sky-600">{editing ? `Edit ${tab.singular}` : `Create ${tab.singular}`}</DialogTitle>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <Field label={`${tab.singular} Name`} required>
              <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inputClass} autoFocus />
            </Field>

            {tabId === "brands" && (
              <>
                <Field label="Parent Brand" hint="Leave empty for a top-level brand; choosing one makes this a Sub Brand.">
                  <select value={form.parentId} onChange={(e) => setForm((f) => ({ ...f, parentId: e.target.value }))} className={inputClass}>
                    <option value="">Select Parent Brand</option>
                    {brandOptions.filter((b) => !editing || b.id !== editing.id).map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Description">
                  <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} className={inputClass} />
                </Field>
              </>
            )}

            {tabId === "units" && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Short Name" required>
                    <input value={form.shortName} onChange={(e) => setForm((f) => ({ ...f, shortName: e.target.value }))} className={inputClass} />
                  </Field>
                  <Field label="Decimal Places" hint="0 for counted goods, 2–3 for weight">
                    <input type="number" min={0} max={4} value={form.decimalPlaces} onChange={(e) => setForm((f) => ({ ...f, decimalPlaces: e.target.value }))} className={inputClass} />
                  </Field>
                </div>
                <Field label="Base Unit" hint="Only if this unit converts into another, e.g. Box → Piece.">
                  <select value={form.baseUnitId} onChange={(e) => setForm((f) => ({ ...f, baseUnitId: e.target.value }))} className={inputClass}>
                    <option value="">Select Base Unit</option>
                    {unitOptions.filter((u) => !editing || u.id !== editing.id).map((u) => (
                      <option key={u.id} value={u.id}>{u.name} ({u.shortName})</option>
                    ))}
                  </select>
                </Field>
                {form.baseUnitId && (
                  <Field label="Conversion Factor" required hint="How many base units one of this unit is worth.">
                    <input type="number" min={0} step="any" value={form.conversionFactor} onChange={(e) => setForm((f) => ({ ...f, conversionFactor: e.target.value }))} className={inputClass} />
                  </Field>
                )}
              </>
            )}

            {tabId === "departments" && (
              <>
                <Field label="Code">
                  <input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} className={inputClass} />
                </Field>
                <Field label="Description">
                  <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} className={inputClass} />
                </Field>
              </>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label="Sort Order">
                <input type="number" value={form.sortOrder} onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))} className={inputClass} />
              </Field>
              <label className="flex items-end gap-2 pb-2">
                <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} className="h-4 w-4 rounded border-neutral-300" />
                <span className="text-sm text-neutral-700">Active</span>
              </label>
            </div>

            <div className="flex justify-end gap-2 border-t border-neutral-100 pt-4">
              <button type="button" onClick={() => setDialogOpen(false)} className="rounded bg-neutral-200 px-4 py-2 text-sm text-neutral-800 hover:bg-neutral-300">Cancel</button>
              <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-60">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Save
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
