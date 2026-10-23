import { useCallback, useEffect, useState } from "react"
import { ImageIcon, Loader2, Plus, Search } from "lucide-react"
import { toast } from "sonner"

import { adminAPI, uploadAPI } from "@food/api"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@food/components/ui/dialog"
import { canCurrentAdminAction } from "@food/utils/adminRbac"

/**
 * Items > Department.
 *
 * Drawn the way the reference ERP draws this one screen, which differs from the
 * Category / Brand card beside it: a breadcrumb rather than a title bar, the
 * search on the left, a bare "+" instead of a Create New button, a Created By
 * column, a vertical "⋮" action menu, and an "N of M records" footer with an
 * "N / Page" selector.
 */

const inp = "h-10 w-full rounded border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-sky-500"
const blank = { name: "", code: "", description: "", image: "", isActive: true }

export default function Department() {
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [search, setSearch] = useState("")
  const [debounced, setDebounced] = useState("")
  const [selected, setSelected] = useState(() => new Set())
  const [menuFor, setMenuFor] = useState(null)

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(blank)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)

  const canCreate = canCurrentAdminAction("create", "/admin/store/departments")
  const canEdit = canCurrentAdminAction("edit", "/admin/store/departments")
  const canDelete = canCurrentAdminAction("delete", "/admin/store/departments")
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const shown = (page - 1) * pageSize + rows.length

  useEffect(() => {
    const id = window.setTimeout(() => { setDebounced(search.trim()); setPage(1) }, 300)
    return () => window.clearTimeout(id)
  }, [search])

  const fetchRows = useCallback(async () => {
    setLoading(true)
    try {
      const params = { page, limit: pageSize }
      if (debounced) params.search = debounced
      const res = await adminAPI.getDepartments(params)
      setRows(res?.data?.data?.departments || [])
      setTotal(Number(res?.data?.data?.total) || 0)
      setSelected(new Set())
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to load departments")
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, debounced])

  useEffect(() => { fetchRows() }, [fetchRows])

  const openCreate = () => { setEditing(null); setForm(blank); setOpen(true) }
  const openEdit = (row) => {
    setMenuFor(null)
    setEditing(row)
    setForm({ name: row.name || "", code: row.code || "", description: row.description || "", image: row.image || "", isActive: row.isActive !== false })
    setOpen(true)
  }

  const onImage = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const res = await uploadAPI.uploadMedia(file, { folder: "switcheats/admin/department" })
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
    if (!form.name.trim()) return toast.error("Department name is required")
    setSaving(true)
    try {
      if (editing) await adminAPI.updateDepartment(editing.id, { ...form, name: form.name.trim() })
      else await adminAPI.createDepartment({ ...form, name: form.name.trim() })
      toast.success(`Department ${editing ? "updated" : "created"}`)
      setOpen(false)
      fetchRows()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const onDelete = async (row) => {
    setMenuFor(null)
    if (!window.confirm(`Delete department "${row.name}"?`)) return
    try {
      await adminAPI.deleteDepartment(row.id)
      toast.success("Department deleted")
      fetchRows()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Delete failed")
    }
  }

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
  const toggleOne = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex items-center gap-2 text-sm">
        <span className="text-neutral-400">⌂</span>
        <span className="text-neutral-400">»</span>
        <span className="font-medium text-neutral-800">Department</span>
      </div>

      <div className="rounded-md border border-neutral-200 bg-white p-4 shadow-sm">
        <div className="mb-4 flex items-center gap-3">
          <div className="relative max-w-md flex-1">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="h-10 w-full rounded-full border border-neutral-300 bg-white pl-4 pr-10 text-sm outline-none focus:border-sky-500" />
            <Search className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          </div>
          {canCreate && (
            <button type="button" onClick={openCreate} className="ml-auto grid h-9 w-9 shrink-0 place-items-center rounded bg-sky-500 text-white hover:bg-sky-600" aria-label="Create New">
              <Plus className="h-5 w-5" />
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-neutral-50 text-left text-neutral-800">
              <tr>
                <th className="w-10 px-3 py-3"><input type="checkbox" checked={allSelected} onChange={toggleAll} className="rounded border-neutral-300" /></th>
                <th className="px-3 py-3 font-semibold">#</th>
                <th className="px-3 py-3 font-semibold">Image</th>
                <th className="px-3 py-3 font-semibold">Name</th>
                <th className="px-3 py-3 font-semibold">Created By</th>
                <th className="px-3 py-3 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-3 py-14 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-neutral-400" /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-14 text-center text-neutral-500">No departments yet.</td></tr>
              ) : rows.map((row, i) => (
                <tr key={row.id} className="border-t border-neutral-100">
                  <td className="px-3 py-3"><input type="checkbox" checked={selected.has(row.id)} onChange={() => toggleOne(row.id)} className="rounded border-neutral-300" /></td>
                  <td className="px-3 py-3 text-neutral-700">{(page - 1) * pageSize + i + 1}</td>
                  <td className="px-3 py-2">
                    <div className="grid h-11 w-11 place-items-center overflow-hidden rounded border border-neutral-200 bg-white">
                      {row.image ? <img src={row.image} alt="" className="h-full w-full object-cover" /> : <ImageIcon className="h-4 w-4 text-neutral-300" />}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-neutral-800">{row.name}</td>
                  <td className="px-3 py-3 text-neutral-700">{row.createdBy || "System"}</td>
                  <td className="relative px-3 py-3 text-right">
                    <button type="button" onClick={() => setMenuFor(menuFor === row.id ? null : row.id)} className="px-2 text-lg leading-none text-neutral-500 hover:text-neutral-800" aria-label="Action">⋮</button>
                    {menuFor === row.id && (
                      <div className="absolute right-3 z-10 mt-1 w-32 rounded border border-neutral-200 bg-white py-1 text-left text-sm shadow-lg">
                        {canEdit && <button type="button" onClick={() => openEdit(row)} className="block w-full px-3 py-1.5 text-left hover:bg-neutral-50">Edit</button>}
                        {canDelete && <button type="button" onClick={() => onDelete(row)} className="block w-full px-3 py-1.5 text-left text-rose-600 hover:bg-rose-50">Delete</button>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-neutral-600">
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }} className="h-9 rounded border border-neutral-300 bg-white px-2">
            {[10, 20, 50, 100].map((n) => <option key={n} value={n}>{n} / Page</option>)}
          </select>
          <div className="flex items-center gap-2">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border border-neutral-300 px-2.5 py-1 disabled:opacity-40">‹</button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).slice(0, 8).map((n) => (
              <button key={n} type="button" onClick={() => setPage(n)} className={`h-7 w-7 rounded ${n === page ? "bg-sky-100 font-semibold text-sky-700" : "hover:bg-neutral-100"}`}>{n}</button>
            ))}
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded border border-neutral-300 px-2.5 py-1 disabled:opacity-40">›</button>
            <span className="ml-2 text-neutral-500">{shown} of {total} records</span>
          </div>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto p-5 sm:max-w-lg sm:p-6">
          <DialogHeader><DialogTitle className="text-sky-600">{editing ? "Edit Department" : "Create Department"}</DialogTitle></DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <label className="block"><span className="mb-1 block text-sm font-semibold text-neutral-800">Department Name<span className="text-rose-500">*</span></span>
              <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inp} autoFocus />
            </label>
            <label className="block"><span className="mb-1 block text-sm font-semibold text-neutral-800">Code</span>
              <input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} className={inp} />
            </label>
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
