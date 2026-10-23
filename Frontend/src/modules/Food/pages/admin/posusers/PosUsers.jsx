import { useCallback, useEffect, useMemo, useState } from "react"
import { Activity, ShieldCheck, Eye, EyeOff, KeyRound, Loader2, Plus, Search, Trash2, UserCog, Wand2 } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@food/components/ui/dialog"
import PosPermissionsDialog, { PermissionsEditor, usePermissionCatalogue } from "./PosPermissions"
import PosUserActivity from "./PosUserActivity"
import { allKeys, formatDateTime, generatePassword, limitsProblem, money, userProblem } from "./posUsersUtils"

/**
 * POS users.
 *
 * The usernames and passwords cashiers sign in to the till with (/pos/login). Each belongs to one
 * store and can only run that store's POS. Deactivating, resetting the password or deleting a user
 * signs them out straight away.
 */

const PAGE_SIZE = 50
const inputClass =
  "h-10 w-full rounded-xl border border-neutral-300 bg-white px-3 text-sm text-neutral-900 outline-none focus:border-primary"
const labelClass = "mb-1.5 block text-xs font-medium text-neutral-500"

const apiMessage = (error, fallback) => error?.response?.data?.message || error?.message || fallback

function PasswordField({ value, onChange, id }) {
  const [show, setShow] = useState(false)
  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <input
          id={id}
          type={show ? "text" : "password"}
          autoComplete="new-password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="At least 6 characters"
          className={`${inputClass} pr-10`}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? "Hide password" : "Show password"}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      <button
        type="button"
        onClick={() => {
          onChange(generatePassword())
          setShow(true)
        }}
        className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-neutral-300 px-3 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
      >
        <Wand2 className="h-4 w-4" /> Generate
      </button>
    </div>
  )
}

function CreateDialog({ open, onOpenChange, stores, defaultStoreId, groups, onCreated }) {
  const empty = { restaurantId: "", name: "", username: "", phone: "", password: "" }
  const [form, setForm] = useState(empty)
  const [access, setAccess] = useState({ permissions: [], limits: { maxBillAmount: "0", maxDiscountPercent: "0" } })
  const everything = allKeys(groups)
  const [saving, setSaving] = useState(false)
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }))
  const problem = userProblem(form, { needPassword: true }) || limitsProblem(access.limits)

  useEffect(() => {
    if (open) {
      setForm({ ...empty, restaurantId: defaultStoreId || "" })
      setAccess({ permissions: everything, limits: { maxBillAmount: "0", maxDiscountPercent: "0" } })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultStoreId, groups])

  const submit = async (e) => {
    e.preventDefault()
    if (problem || saving) return
    setSaving(true)
    try {
      await adminAPI.createPosUser({
        ...form,
        username: form.username.trim().toLowerCase(),
        permissions: access.permissions,
        limits: {
          maxBillAmount: Number(access.limits.maxBillAmount) || 0,
          maxDiscountPercent: Number(access.limits.maxDiscountPercent) || 0,
        },
      })
      toast.success(`POS user "${form.username.trim().toLowerCase()}" created`)
      onOpenChange(false)
      onCreated()
    } catch (error) {
      toast.error(apiMessage(error, "Could not create the POS user"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto p-5 sm:max-w-2xl sm:p-6">
        <DialogHeader className="pr-8">
          <DialogTitle className="text-lg font-bold text-neutral-900">New POS user</DialogTitle>
          <DialogDescription>They sign in at /pos/login and can only run the till of the store you pick.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="pu-store" className={labelClass}>Store</label>
            <select id="pu-store" value={form.restaurantId} onChange={(e) => set("restaurantId")(e.target.value)} className={inputClass}>
              <option value="">Select a store</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="pu-name" className={labelClass}>Full name</label>
              <input id="pu-name" value={form.name} onChange={(e) => set("name")(e.target.value)} placeholder="e.g. Asha Kumar" maxLength={80} className={inputClass} />
            </div>
            <div>
              <label htmlFor="pu-phone" className={labelClass}>Phone (optional)</label>
              <input id="pu-phone" value={form.phone} onChange={(e) => set("phone")(e.target.value)} inputMode="tel" placeholder="9876543210" className={inputClass} />
            </div>
          </div>
          <div>
            <label htmlFor="pu-username" className={labelClass}>Username</label>
            <input
              id="pu-username"
              value={form.username}
              onChange={(e) => set("username")(e.target.value.toLowerCase())}
              autoCapitalize="none"
              spellCheck={false}
              autoComplete="off"
              placeholder="e.g. asha.k"
              maxLength={30}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="pu-password" className={labelClass}>Password</label>
            <PasswordField id="pu-password" value={form.password} onChange={set("password")} />
          </div>
          <div className="border-t border-neutral-100 pt-4">
            <PermissionsEditor groups={groups} value={access} onChange={setAccess} />
          </div>
          {problem && (form.name || form.username || form.password) ? (
            <p className="text-xs text-amber-700" role="status">{problem}</p>
          ) : null}
          <DialogFooter className="gap-2 pt-1">
            <button type="button" onClick={() => onOpenChange(false)} className="h-10 rounded-full border border-neutral-300 px-5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
              Cancel
            </button>
            <button
              type="submit"
              disabled={Boolean(problem) || saving}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create user
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EditDialog({ user, onClose, onSaved }) {
  const [form, setForm] = useState({ name: "", phone: "" })
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (user) setForm({ name: user.name || "", phone: user.phone || "" })
  }, [user])
  const problem = userProblem({ ...form, username: "valid", password: "" }, { needPassword: false, needStore: false })

  const submit = async (e) => {
    e.preventDefault()
    if (problem || saving) return
    setSaving(true)
    try {
      await adminAPI.updatePosUser(user.id, { name: form.name.trim(), phone: form.phone.trim() })
      toast.success("POS user updated")
      onClose()
      onSaved()
    } catch (error) {
      toast.error(apiMessage(error, "Could not update the POS user"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="p-5 sm:max-w-md sm:p-6">
        <DialogHeader className="pr-8">
          <DialogTitle className="text-lg font-bold text-neutral-900">Edit POS user</DialogTitle>
          <DialogDescription>Username {user?.username} · {user?.restaurantName}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="pe-name" className={labelClass}>Full name</label>
            <input id="pe-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} maxLength={80} className={inputClass} />
          </div>
          <div>
            <label htmlFor="pe-phone" className={labelClass}>Phone (optional)</label>
            <input id="pe-phone" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} inputMode="tel" className={inputClass} />
          </div>
          {problem ? <p className="text-xs text-amber-700" role="status">{problem}</p> : null}
          <DialogFooter className="gap-2 pt-1">
            <button type="button" onClick={onClose} className="h-10 rounded-full border border-neutral-300 px-5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">Cancel</button>
            <button type="submit" disabled={Boolean(problem) || saving} className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-40">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save changes
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PasswordDialog({ user, onClose }) {
  const [password, setPassword] = useState("")
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (user) setPassword("")
  }, [user])
  const problem = password.length < 6 ? "Password must be at least 6 characters" : ""

  const submit = async (e) => {
    e.preventDefault()
    if (problem || saving) return
    setSaving(true)
    try {
      await adminAPI.resetPosUserPassword(user.id, password)
      toast.success(`New password set for ${user.username}. They have been signed out.`)
      onClose()
    } catch (error) {
      toast.error(apiMessage(error, "Could not change the password"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="p-5 sm:max-w-md sm:p-6">
        <DialogHeader className="pr-8">
          <DialogTitle className="text-lg font-bold text-neutral-900">Reset password</DialogTitle>
          <DialogDescription>{user?.name} · {user?.username}. They are signed out of the till and need the new password.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="pp-password" className={labelClass}>New password</label>
            <PasswordField id="pp-password" value={password} onChange={setPassword} />
          </div>
          <DialogFooter className="gap-2 pt-1">
            <button type="button" onClick={onClose} className="h-10 rounded-full border border-neutral-300 px-5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">Cancel</button>
            <button type="submit" disabled={Boolean(problem) || saving} className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-40">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Set password
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteDialog({ user, onClose, onDeleted }) {
  const [deleting, setDeleting] = useState(false)
  const confirm = async () => {
    setDeleting(true)
    try {
      await adminAPI.deletePosUser(user.id)
      toast.success(`POS user "${user.username}" deleted`)
      onClose()
      onDeleted()
    } catch (error) {
      toast.error(apiMessage(error, "Could not delete the POS user"))
    } finally {
      setDeleting(false)
    }
  }
  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="p-5 sm:max-w-md sm:p-6">
        <DialogHeader className="pr-8">
          <DialogTitle className="text-lg font-bold text-neutral-900">Delete POS user?</DialogTitle>
          <DialogDescription>
            {user?.name} ({user?.username}) will be removed and signed out at once. This cannot be undone. To keep the account but stop it signing in, switch it off instead.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 pt-1">
          <button type="button" onClick={onClose} className="h-10 rounded-full border border-neutral-300 px-5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">Cancel</button>
          <button type="button" onClick={confirm} disabled={deleting} className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-rose-600 px-5 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-40">
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Delete
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ActiveSwitch({ on, busy, label, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-primary" : "bg-neutral-300"}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  )
}

export default function PosUsers() {
  const [users, setUsers] = useState([])
  const [summary, setSummary] = useState({ total: 0, active: 0, inactive: 0 })
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [debounced, setDebounced] = useState("")
  const [storeFilter, setStoreFilter] = useState("")
  const [stores, setStores] = useState([])
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [resetting, setResetting] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [tracking, setTracking] = useState(null)
  const [permsFor, setPermsFor] = useState(null)
  const groups = usePermissionCatalogue()
  const [busyId, setBusyId] = useState("")

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim())
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    let cancelled = false
    adminAPI
      .getRestaurants({ status: "approved", limit: 1000 })
      .then((res) => {
        if (cancelled) return
        const list = res?.data?.data?.restaurants || res?.data?.data?.items || res?.data?.restaurants || []
        setStores(
          list
            .map((r) => ({ id: String(r._id || r.id), name: r.restaurantName || r.name || "Store" }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminAPI.getPosUsers({
        page,
        limit: PAGE_SIZE,
        ...(debounced ? { search: debounced } : {}),
        ...(storeFilter ? { restaurantId: storeFilter } : {}),
      })
      const data = res?.data?.data || {}
      setUsers(data.users || [])
      setTotal(data.total || 0)
      setSummary(data.summary || { total: 0, active: 0, inactive: 0 })
    } catch (error) {
      toast.error(apiMessage(error, "Failed to load POS users"))
    } finally {
      setLoading(false)
    }
  }, [page, debounced, storeFilter])

  useEffect(() => {
    load()
  }, [load])

  const toggleActive = async (user, next) => {
    setBusyId(user.id)
    try {
      await adminAPI.updatePosUser(user.id, { isActive: next })
      setUsers((rows) => rows.map((r) => (r.id === user.id ? { ...r, isActive: next } : r)))
      setSummary((s) => ({ ...s, active: s.active + (next ? 1 : -1), inactive: s.inactive + (next ? -1 : 1) }))
      toast.success(next ? `${user.username} can sign in again` : `${user.username} switched off and signed out`)
    } catch (error) {
      toast.error(apiMessage(error, "Could not change the account"))
    } finally {
      setBusyId("")
    }
  }

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total])

  return (
    <div className="mx-auto max-w-[1400px] p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900">POS users</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Logins for cashiers, and everything they do at the till: click a name to see their bills, registers and cash. Each one signs in at <span className="font-medium text-neutral-700">/pos/login</span> and can only run their own store&apos;s till.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-white shadow-sm hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> New POS user
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {[
          ["Users", summary.total],
          ["Active", summary.active],
          ["Switched off", summary.inactive],
        ].map(([label, value]) => (
          <span key={label} className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-500">
            {label} <b className="ml-1 text-neutral-900">{value}</b>
          </span>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, username or phone"
            aria-label="Search POS users"
            className="h-10 w-full rounded-full border border-neutral-300 bg-white pl-9 pr-3 text-sm outline-none focus:border-primary"
          />
        </div>
        <select
          value={storeFilter}
          onChange={(e) => {
            setStoreFilter(e.target.value)
            setPage(1)
          }}
          aria-label="Filter by store"
          className="h-10 rounded-full border border-neutral-300 bg-white px-3 text-sm text-neutral-700 outline-none focus:border-primary"
        >
          <option value="">All stores</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Username</th>
                <th className="px-4 py-3 font-medium">Store</th>
                <th className="px-4 py-3 font-medium">Today</th>
                <th className="px-4 py-3 font-medium">Register</th>
                <th className="px-4 py-3 font-medium">Last active</th>
                <th className="px-4 py-3 font-medium">Active</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-16 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-neutral-300" />
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-16 text-center text-neutral-500">
                    {debounced || storeFilter ? "No POS users match." : "No POS users yet. Create one to give a cashier a till login."}
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id} className={u.isActive ? "" : "bg-neutral-50/60"}>
                    <td className="px-4 py-3">
                      <button type="button" onClick={() => setTracking(u)} className="text-left" title="See everything this user did">
                        <p className="font-medium text-neutral-900 underline-offset-2 hover:underline">{u.name}</p>
                        {u.phone ? <p className="text-xs text-neutral-500">{u.phone}</p> : null}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-mono text-[13px] text-neutral-700">{u.username}</p>
                      <p className="text-[11px] text-neutral-400">{u.permissions?.length ?? 0} of {allKeys(groups).length || u.permissions?.length || 0} permissions</p>
                    </td>
                    <td className="px-4 py-3 text-neutral-700">{u.restaurantName || "—"}</td>
                    <td className="px-4 py-3 text-neutral-700">
                      <p className="font-medium text-neutral-900">{money(u.today?.sales)}</p>
                      <p className="text-xs text-neutral-500">{u.today?.bills || 0} bills</p>
                    </td>
                    <td className="px-4 py-3">
                      {u.registerOpen ? (
                        <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700">Open since {formatDateTime(u.registerOpenedAt)}</span>
                      ) : (
                        <span className="text-xs text-neutral-400">Closed</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-neutral-500">{u.lastActiveAt ? formatDateTime(u.lastActiveAt) : "Never"}</td>
                    <td className="px-4 py-3">
                      <ActiveSwitch
                        on={u.isActive}
                        busy={busyId === u.id}
                        label={`${u.isActive ? "Switch off" : "Switch on"} ${u.username}`}
                        onChange={(next) => toggleActive(u, next)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1.5">
                        <button type="button" onClick={() => setTracking(u)} title="Activity" aria-label={`Activity of ${u.username}`} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-600 hover:bg-neutral-50">
                          <Activity className="h-4 w-4" />
                        </button>
                        <button type="button" onClick={() => setPermsFor(u)} title="Permissions" aria-label={`Permissions of ${u.username}`} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-600 hover:bg-neutral-50">
                          <ShieldCheck className="h-4 w-4" />
                        </button>
                        <button type="button" onClick={() => setEditing(u)} title="Edit" aria-label={`Edit ${u.username}`} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-600 hover:bg-neutral-50">
                          <UserCog className="h-4 w-4" />
                        </button>
                        <button type="button" onClick={() => setResetting(u)} title="Reset password" aria-label={`Reset password for ${u.username}`} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-600 hover:bg-neutral-50">
                          <KeyRound className="h-4 w-4" />
                        </button>
                        <button type="button" onClick={() => setDeleting(u)} title="Delete" aria-label={`Delete ${u.username}`} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 ? (
        <div className="mt-4 flex items-center justify-end gap-2 text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="h-9 rounded-lg border border-neutral-300 px-3 font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40">
            Previous
          </button>
          <span className="min-w-[90px] text-center text-neutral-600">Page {page} of {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="h-9 rounded-lg border border-neutral-300 px-3 font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40">
            Next
          </button>
        </div>
      ) : null}

      <CreateDialog open={createOpen} onOpenChange={setCreateOpen} stores={stores} defaultStoreId={storeFilter} groups={groups} onCreated={load} />
      <PosPermissionsDialog user={permsFor} groups={groups} onClose={() => setPermsFor(null)} onSaved={load} />
      <PosUserActivity user={tracking} onClose={() => setTracking(null)} />
      <EditDialog user={editing} onClose={() => setEditing(null)} onSaved={load} />
      <PasswordDialog user={resetting} onClose={() => setResetting(null)} />
      <DeleteDialog user={deleting} onClose={() => setDeleting(null)} onDeleted={load} />
    </div>
  )
}
