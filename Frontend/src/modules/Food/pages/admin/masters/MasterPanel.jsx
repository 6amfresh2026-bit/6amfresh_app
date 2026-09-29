import { useCallback, useEffect, useState } from "react"
import { ImageIcon, Loader2, Pencil, Search, Settings2, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { adminAPI, uploadAPI } from "@food/api"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@food/components/ui/dialog"
import { canCurrentAdminAction } from "@food/utils/adminRbac"

/**
 * One panel of the Category / Brand screen.
 *
 * The reference ERP puts Category and Brand side by side on a single page, each
 * as its own card with its own page size, search and Create New. The two lists
 * hold the same shape of record — name, code, description, image, a parent —
 * so this component is configured for either rather than written twice.
 */

const inp = "h-10 w-full rounded border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-sky-500"

export const CATEGORY_PANEL = {
  key: "category",
  title: "Category",
  singular: "Category",
  parentLabel: "Parent Category",
  rbacPath: "/admin/store/categories",
  list: (params) => adminAPI.getCategories(params),
  pick: (res) => {
    const d = res?.data?.data || {}
    const rows = d.categories || (Array.isArray(d) ? d : [])
    return { rows, total: Number(d.total) || rows.length }
  },
  create: (body) => adminAPI.createCategory(body),
  update: (id, body) => adminAPI.updateCategory(id, body),
  remove: (id) => adminAPI.deleteCategory(id),
}

export const BRAND_PANEL = {
  key: "brand",
  title: "Brand",
  singular: "Brand",
  parentLabel: "Parent Brand",
  rbacPath: "/admin/store/brands",
  list: (params) => adminAPI.getBrands(params),
  pick: (res) => {
    const d = res?.data?.data || {}
    return { rows: d.brands || [], total: Number(d.total) || 0 }
  },
  create: (body) => adminAPI.createBrand(body),
  update: (id, body) => adminAPI.updateBrand(id, body),
  remove: (id) => adminAPI.deleteBrand(id),
}

const blank = { name: "", code: "", description: "", parentId: "", image: "", isActive: true }

export default function MasterPanel({ config }) {
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [search, setSearch] = useState("")
  const [debounced, setDebounced] = useState("")
  const [selected, setSelected] = useState(() => new Set())

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(blank)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [parents, setParents] = useState([])

  const canCreate = canCurrentAdminAction("create", config.rbacPath)
  const canEdit = canCurrentAdminAction("edit", config.rbacPath)
  const canDelete = canCurrentAdminAction("delete", config.rbacPath)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  useEffect(() => {
    const id = window.setTimeout(() => { setDebounced(search.trim()); setPage(1) }, 300)
    return () => window.clearTimeout(id)
  }, [search])

  const fetchRows = useCallback(async () => {
    setLoading(true)
    try {
      const params = { page, limit: pageSize }
      if (debounced) params.search = debounced
      const { rows: r, total: t } = config.pick(await config.list(params))
      setRows(r)
      setTotal(t)
      setSelected(new Set())
    } catch (error) {
      toast.error(error?.response?.data?.message || `Failed to load ${config.title.toLowerCase()}`)
      setRows([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [config, page, pageSize, debounced])

  useEffect(() => { fetchRows() }, [fetchRows])

  // Parent picker: top-level rows only, so a child cannot be chosen as a parent.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      try {
        const { rows: r } = config.pick(await config.list({ limit: 200, parentId: "none" }))
        if (!cancelled) setParents(r.filter((x) => !x.parentId))
      } catch { /* leave the picker empty; a top-level record still saves */ }
    })()
    return () => { cancelled = true }
  }, [open, config])

  const openCreate = () => { setEditing(null); setForm(blank); setOpen(true) }
  const openEdit = (row) => {
    setEditing(row)
    setForm({
      name: row.name || "",
      code: row.code || "",
      description: row.description || "",
      parentId: row.parentId ? String(row.parentId) : "",
      image: row.image || "",
      isActive: row.isActive !== false,
    })
    setOpen(true)
  }

  const onImage = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const res = await uploadAPI.uploadMedia(file, { folder: `switcheats/admin/${config.key}` })
      const url = res?.data?.data?.url || res?.data?.url || ""
      if (!url) throw new Error("no url")
      setForm((f) => ({ ...f, image: url }))
    } catch {
      toast.error("Image upload failed")
    } finally {
      setUploading(false)
    }
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) return toast.error(`${config.singular} name is required`)
    setSaving(true)
    try {
      const body = { ...form, name: form.name.trim(), parentId: form.parentId || "" }
      if (editing) await config.update(editing.id || editing._id, body)
      else await config.create(body)
      toast.success(`${config.singular} ${editing ? "updated" : "created"}`)
      setOpen(false)
      fetchRows()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const onDelete = async (row) => {
    if (!window.confirm(`Delete ${config.singular.toLowerCase()} "${row.name}"?`)) return
    try {
      await config.remove(row.id || row._id)
      toast.success(`${config.singular} deleted`)
      fetchRows()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Delete failed")
    }
  }

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id || r._id))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id || r._id)))
  const toggleOne = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <div className="rounded-md border border-neutral-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 px-4 py-3">
        <Settings2 className="h-4 w-4 text-neutral-400" />
        <h2 className="font-medium text-sky-600">{config.title}</h2>
        <div className="ml-auto flex items-center gap-2">
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }} className="h-9 rounded border border-neutral-300 bg-white px-2 text-sm">
            {[10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <div className="relative">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search List..." className="h-9 w-40 rounded border border-neutral-300 bg-white pl-3 pr-8 text-sm outline-none focus:border-sky-500" />
            <Search className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          </div>
          {canCreate && <button type="button" onClick={openCreate} className="h-9 shrink-0 rounded bg-sky-500 px-3 text-sm font-medium text-white hover:bg-sky-600">Create New</button>}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-neutral-100 text-left text-neutral-800">
            <tr>
              <th className="w-8 px-3 py-3"><input type="checkbox" checked={allSelected} onChange={toggleAll} className="rounded border-neutral-300" /></th>
              <th className="px-3 py-3 font-semibold">#</th>
              <th className="px-3 py-3 font-semibold">Image</th>
              <th className="px-3 py-3 font-semibold">Name</th>
              <th className="px-3 py-3 font-semibold">Code</th>
              <th className="px-3 py-3 font-semibold">Description</th>
              <th className="px-3 py-3 font-semibold">{config.parentLabel}</th>
              <th className="px-3 py-3 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="px-3 py-14 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-neutral-400" /></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-14 text-center text-neutral-500">No {config.title.toLowerCase()} yet.</td></tr>
            ) : rows.map((row, i) => {
              const id = row.id || row._id
              return (
                <tr key={id} className="border-t border-neutral-100">
                  <td className="px-3 py-3"><input type="checkbox" checked={selected.has(id)} onChange={() => toggleOne(id)} className="rounded border-neutral-300" /></td>
                  <td className="px-3 py-3 text-neutral-700">{(page - 1) * pageSize + i + 1}</td>
                  <td className="px-3 py-2">
                    <div className="grid h-11 w-11 place-items-center overflow-hidden rounded border border-neutral-200 bg-white">
                      {row.image ? <img src={row.image} alt="" className="h-full w-full object-cover" /> : <ImageIcon className="h-4 w-4 text-neutral-300" />}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-neutral-800">{row.name}</td>
                  <td className="px-3 py-3 text-neutral-700">{row.code || ""}</td>
                  <td className="px-3 py-3 text-neutral-700">{row.description || ""}</td>
                  <td className="px-3 py-3 text-neutral-700">{row.parentName || ""}</td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-3">
                      {canEdit && <button type="button" onClick={() => openEdit(row)} className="text-sky-600 hover:text-sky-700" aria-label="Edit"><Pencil className="h-4 w-4" /></button>}
                      {canDelete && <button type="button" onClick={() => onDelete(row)} className="text-rose-500 hover:text-rose-600" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-neutral-100 px-4 py-3 text-sm text-neutral-600">
        <span>Showing {rows.length ? (page - 1) * pageSize + 1 : 0} to {(page - 1) * pageSize + rows.length} of {total}</span>
        <div className="flex items-center gap-2">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border border-neutral-300 px-2.5 py-1 disabled:opacity-40">Prev</button>
          <span>{page} / {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded border border-neutral-300 px-2.5 py-1 disabled:opacity-40">Next</button>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto p-6 pr-10 sm:max-w-lg">
          <DialogHeader><DialogTitle className="text-sky-600">{editing ? `Edit ${config.singular}` : `Create ${config.singular}`}</DialogTitle></DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <label className="block"><span className="mb-1 block text-sm font-semibold text-neutral-800">{config.singular} Name<span className="text-rose-500">*</span></span>
              <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inp} autoFocus />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className="mb-1 block text-sm font-semibold text-neutral-800">Code</span>
                <input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} className={inp} />
              </label>
              <label className="block"><span className="mb-1 block text-sm font-semibold text-neutral-800">{config.parentLabel}</span>
                <select value={form.parentId} onChange={(e) => setForm((f) => ({ ...f, parentId: e.target.value }))} className={inp}>
                  <option value="">None (top level)</option>
                  {parents.filter((p) => !editing || String(p.id || p._id) !== String(editing.id || editing._id)).map((p) => (
                    <option key={p.id || p._id} value={p.id || p._id}>{p.name}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block"><span className="mb-1 block text-sm font-semibold text-neutral-800">Description</span>
              <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} className="w-full rounded border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-sky-500" />
            </label>
            <div>
              <span className="mb-1 block text-sm font-semibold text-neutral-800">Image</span>
              <div className="flex items-center gap-2">
                {form.image && <img src={form.image} alt="" className="h-10 w-10 rounded border object-cover" />}
                <input type="file" accept="image/*" onChange={onImage} disabled={uploading} className="text-xs" />
                {uploading && <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-neutral-800">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} className="h-4 w-4 rounded border-neutral-300 accent-sky-500" />
              Active
            </label>
            <div className="flex justify-end gap-2 border-t border-neutral-100 pt-4">
              <button type="button" onClick={() => setOpen(false)} className="rounded bg-neutral-200 px-4 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded bg-sky-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">{saving && <Loader2 className="h-4 w-4 animate-spin" />} Save</button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
