import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@food/components/ui/dialog"
import { allKeys, limitsProblem, toggleGroup, toggleKey } from "./posUsersUtils"

/**
 * What a POS user may do at the till, and how big a bill or discount they may give. The same editor
 * is used when creating a user and from the "Permissions" action on a row. The list of permissions
 * comes from the server, so a new one appears here without a change to this screen.
 */

const inputClass =
  "h-10 w-full rounded-xl border border-neutral-300 bg-white px-3 text-sm text-neutral-900 outline-none focus:border-primary"

export function usePermissionCatalogue() {
  const [groups, setGroups] = useState([])
  useEffect(() => {
    let cancelled = false
    adminAPI
      .getPosPermissions()
      .then((res) => {
        if (!cancelled) setGroups(res?.data?.data?.groups || [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return groups
}

const chipClass = (on) =>
  `inline-flex cursor-pointer items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
    on ? "border-primary/40 bg-primary/5 text-neutral-900" : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50"
  }`

/** The editor itself: limits, then the permissions by group. */
export function PermissionsEditor({ groups, value, onChange }) {
  const { permissions, limits } = value
  const set = (patch) => onChange({ ...value, ...patch })
  const everything = allKeys(groups)
  const problem = limitsProblem(limits)

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="pp-max-bill" className="mb-1.5 block text-xs font-medium text-neutral-500">
            Bill limit ₹ (0 = no limit)
          </label>
          <input
            id="pp-max-bill"
            inputMode="decimal"
            value={limits.maxBillAmount}
            onChange={(e) => set({ limits: { ...limits, maxBillAmount: e.target.value } })}
            className={inputClass}
          />
          <p className="mt-1 text-[11px] text-neutral-400">The biggest bill this person can ring up.</p>
        </div>
        <div>
          <label htmlFor="pp-max-discount" className="mb-1.5 block text-xs font-medium text-neutral-500">
            Discount limit % (0 = no limit)
          </label>
          <input
            id="pp-max-discount"
            inputMode="decimal"
            value={limits.maxDiscountPercent}
            onChange={(e) => set({ limits: { ...limits, maxDiscountPercent: e.target.value } })}
            className={inputClass}
          />
          <p className="mt-1 text-[11px] text-neutral-400">Most they can take off a bill. Needs &quot;Give discounts&quot;.</p>
        </div>
      </div>
      {problem ? <p className="text-xs text-amber-700" role="status">{problem}</p> : null}

      <div>
        <div className="mb-2 flex items-center gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Allowed at the till</p>
          <button type="button" onClick={() => set({ permissions: everything })} className="rounded-full border border-primary/40 px-3 py-0.5 text-xs font-medium text-primary hover:bg-primary/5">
            Select all
          </button>
          <button type="button" onClick={() => set({ permissions: [] })} className="rounded-full border border-neutral-300 px-3 py-0.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50">
            Clear all
          </button>
        </div>

        {groups.length === 0 ? (
          <Loader2 className="my-4 h-5 w-5 animate-spin text-neutral-300" />
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.key}>
                <div className="mb-1.5 flex items-center gap-2">
                  <p className="text-sm font-semibold text-neutral-900">{g.label}</p>
                  <button type="button" onClick={() => set({ permissions: toggleGroup(permissions, g) })} className="text-xs text-primary underline underline-offset-2">
                    toggle group
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {g.permissions.map((p) => {
                    const on = permissions.includes(p.key)
                    return (
                      <label key={p.key} className={chipClass(on)}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => set({ permissions: toggleKey(permissions, p.key) })}
                          className="h-4 w-4 accent-[color:var(--module-theme,#10b981)]"
                        />
                        {p.label}
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** The row action: edit one user's permissions and limits. */
export default function PosPermissionsDialog({ user, groups, onClose, onSaved }) {
  const [value, setValue] = useState({ permissions: [], limits: { maxBillAmount: "0", maxDiscountPercent: "0" } })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (user) {
      setValue({
        permissions: user.permissions || [],
        limits: {
          maxBillAmount: String(user.limits?.maxBillAmount ?? 0),
          maxDiscountPercent: String(user.limits?.maxDiscountPercent ?? 0),
        },
      })
    }
  }, [user])

  const problem = limitsProblem(value.limits)

  const save = async () => {
    if (problem || saving) return
    setSaving(true)
    try {
      await adminAPI.updatePosUser(user.id, {
        permissions: value.permissions,
        limits: {
          maxBillAmount: Number(value.limits.maxBillAmount) || 0,
          maxDiscountPercent: Number(value.limits.maxDiscountPercent) || 0,
        },
      })
      toast.success(`Permissions saved for ${user.username}`)
      onClose()
      onSaved()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not save permissions")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto p-5 sm:max-w-2xl sm:p-6">
        <DialogHeader className="pr-8">
          <DialogTitle className="text-lg font-bold text-neutral-900">Permissions</DialogTitle>
          <DialogDescription>
            {user?.name} · {user?.username}. Changes apply at the till within a minute, and the server enforces them straight away.
          </DialogDescription>
        </DialogHeader>
        <PermissionsEditor groups={groups} value={value} onChange={setValue} />
        <DialogFooter className="gap-2 pt-1">
          <button type="button" onClick={onClose} className="h-10 rounded-full border border-neutral-300 px-5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">Cancel</button>
          <button type="button" onClick={save} disabled={Boolean(problem) || saving} className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-40">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save permissions
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
