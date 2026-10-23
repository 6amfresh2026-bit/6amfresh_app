import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Clock, Loader2, Search } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"
import {
  buildPatch,
  closedReasonText,
  customerChip,
  draftProblem,
  instantChip,
  isDirty,
  posChip,
} from "./appTimingsUtils"

/**
 * App timings & store status.
 *
 * One card per approved store. The admin sets when that store takes customer-app orders and
 * instant delivery, and what customers are told while it is closed. The chips at the top of each
 * card are live: the till's last check-in and what customers can actually do right now, from the
 * same availability check checkout uses. The list refreshes every few seconds; a card the admin
 * is editing keeps its unsaved changes while the chips around it move.
 */

const REFRESH_MS = 10000
const PAGE_SIZE = 50
const MESSAGE_MAX = 280

const today = () => new Date().toLocaleDateString("en-IN", { weekday: "long", month: "long", day: "numeric" })

const CHIP_TONE = {
  green: "border-emerald-200 bg-emerald-50 text-emerald-700",
  red: "border-rose-200 bg-rose-50 text-rose-700",
  gray: "border-neutral-200 bg-neutral-50 text-neutral-500",
}

function Chip({ tone, children }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${CHIP_TONE[tone] || CHIP_TONE.gray}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone === "green" ? "bg-emerald-500" : tone === "red" ? "bg-rose-500" : "bg-neutral-300"}`} />
      {children}
    </span>
  )
}

/** A row of mutually exclusive choices, drawn as joined buttons. */
function Segmented({ value, options, onChange, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-full overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50">
      {options.map((opt) => {
        const on = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(opt.value)}
            className={`h-10 flex-1 whitespace-nowrap px-2 text-sm font-medium transition-colors ${on ? "bg-primary text-white" : "text-neutral-600 hover:bg-white"}`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function TimeField({ label, value, onChange, dim }) {
  return (
    <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-neutral-600">
      {label ? <span className="w-9 shrink-0">{label}</span> : null}
      <input
        type="time"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        className={`h-10 w-full min-w-0 rounded-xl border border-neutral-300 bg-white px-3 text-neutral-900 outline-none focus:border-primary ${dim ? "opacity-50" : ""}`}
      />
    </label>
  )
}

function StoreCard({ store, draft, onDraft, onSave, saving }) {
  const cfg = draft || store.config
  const set = (key, value) => onDraft(store.id, { ...cfg, [key]: value })
  const dirty = isDirty(store.config, draft)
  const problem = draftProblem(draft)
  const pos = posChip(store)
  const app = customerChip(store)
  const instant = instantChip(store)
  const reason = closedReasonText(store)
  const following = cfg.customerMode === "follow"
  const instantFollowing = cfg.instantMode === "follow"

  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm" aria-label={store.name}>
      <header>
        <h2 className="text-lg font-bold text-neutral-900">
          {store.name}
          {store.zoneName ? <span className="ml-2 text-xs font-medium text-neutral-400">{store.zoneName}</span> : null}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Chip tone={pos.tone}>{pos.text}</Chip>
          <Chip tone={app.tone}>{app.text}</Chip>
          <Chip tone={instant.tone}>{instant.text}</Chip>
        </div>
        {reason ? <p className="mt-1.5 text-xs text-neutral-500">{reason}</p> : null}
      </header>

      <div className="mt-5 grid items-start gap-6 lg:grid-cols-3">
        <div>
          <p className="mb-2 text-xs font-medium text-neutral-500">Customer app</p>
          <Segmented
            label={`Customer app, ${store.name}`}
            value={cfg.customerMode}
            onChange={(v) => set("customerMode", v)}
            options={[
              { value: "follow", label: "Follow timings" },
              { value: "open", label: "Force open" },
              { value: "closed", label: "Force closed" },
            ]}
          />
          <div className="mt-3 flex flex-nowrap items-center gap-2">
            <TimeField label="Open" value={cfg.openTime} onChange={(v) => set("openTime", v)} dim={!following} />
            <span className="shrink-0 text-sm text-neutral-400">to</span>
            <TimeField label="" value={cfg.closeTime} onChange={(v) => set("closeTime", v)} dim={!following} />
          </div>
          <p className="mt-2 text-xs text-neutral-400">
            Force open ignores the timings (and the store&apos;s own hours) but still needs the POS to be online where that is required.
          </p>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-neutral-500">Instant delivery (30 min)</p>
          <Segmented
            label={`Instant delivery, ${store.name}`}
            value={cfg.instantMode}
            onChange={(v) => set("instantMode", v)}
            options={[
              { value: "follow", label: "Follow timings" },
              { value: "on", label: "Always on" },
              { value: "off", label: "Switch off" },
            ]}
          />
          <div className="mt-3 flex flex-nowrap items-center gap-2">
            <TimeField label="Live" value={cfg.instantFrom} onChange={(v) => set("instantFrom", v)} dim={!instantFollowing} />
            <span className="shrink-0 text-sm text-neutral-400">to</span>
            <TimeField label="" value={cfg.instantTo} onChange={(v) => set("instantTo", v)} dim={!instantFollowing} />
          </div>
          <p className="mt-2 text-xs text-neutral-400">Never goes live while the app is closed.</p>
        </div>

        <div>
          <label className="block">
            <span className="mb-2 block text-xs font-medium text-neutral-500">Message customers see when closed</span>
            <textarea
              value={cfg.closedMessage || ""}
              onChange={(e) => set("closedMessage", e.target.value)}
              maxLength={MESSAGE_MAX}
              rows={3}
              placeholder="e.g. We are closed for stock count. Back at 4 pm."
              className="w-full resize-y rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-primary"
            />
          </label>
          <div className="mt-1 text-right text-[11px] text-neutral-400">{(cfg.closedMessage || "").length}/{MESSAGE_MAX}</div>
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={Boolean(cfg.requirePosOnline)}
              onChange={(e) => set("requirePosOnline", e.target.checked)}
              className="h-4 w-4 accent-[color:var(--module-theme,#10b981)]"
            />
            Require POS online to take orders
          </label>
        </div>
      </div>

      <footer className="mt-4 flex flex-wrap items-center justify-end gap-3">
        {problem ? <p className="mr-auto text-xs text-rose-600" role="alert">{problem}</p> : null}
        {!problem && dirty ? <p className="mr-auto text-xs text-amber-700">Unsaved changes</p> : null}
        <button
          type="button"
          onClick={() => onSave(store)}
          disabled={!dirty || Boolean(problem) || saving}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save timings
        </button>
      </footer>
    </section>
  )
}

export default function AppTimings() {
  const [stores, setStores] = useState([])
  const [summary, setSummary] = useState({ shown: 0, posOnline: 0, customerOpen: 0, instantLive: 0 })
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState(null)
  const [search, setSearch] = useState("")
  const [debounced, setDebounced] = useState("")
  const [zoneId, setZoneId] = useState("")
  const [zones, setZones] = useState([])
  const [page, setPage] = useState(1)
  const [drafts, setDrafts] = useState({})
  const [savingId, setSavingId] = useState("")
  const query = useRef({})

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 300)
    return () => clearTimeout(id)
  }, [search])

  useEffect(() => {
    setPage(1)
  }, [debounced, zoneId])

  useEffect(() => {
    ;(async () => {
      try {
        const res = await adminAPI.getZones({ page: 1, limit: 1000 })
        const list = res?.data?.data?.zones || []
        setZones(Array.isArray(list) ? list : [])
      } catch {
        /* the zone filter simply stays empty */
      }
    })()
  }, [])

  query.current = { page, limit: PAGE_SIZE, ...(debounced ? { search: debounced } : {}), ...(zoneId ? { zoneId } : {}) }

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    try {
      const res = await adminAPI.getAppTimings(query.current)
      const d = res?.data?.data || {}
      setStores(d.stores || [])
      setTotal(Number(d.total) || 0)
      setSummary(d.summary || { shown: 0, posOnline: 0, customerOpen: 0, instantLive: 0 })
      setUpdatedAt(new Date())
    } catch (error) {
      if (!quiet) toast.error(error?.response?.data?.message || "Failed to load store timings")
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, page, debounced, zoneId])

  // Keep the chips live. Drafts live in their own state, so a refresh never touches an edit in progress.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load({ quiet: true })
    }, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  const onDraft = (id, next) => setDrafts((d) => ({ ...d, [id]: next }))

  const onSave = async (store) => {
    const patch = buildPatch(store.config, drafts[store.id])
    if (Object.keys(patch).length === 0) return
    setSavingId(store.id)
    try {
      const res = await adminAPI.saveAppTimings(store.id, patch)
      const saved = res?.data?.data?.store
      if (saved) setStores((list) => list.map((s) => (s.id === saved.id ? saved : s)))
      setDrafts((d) => {
        const { [store.id]: _gone, ...rest } = d
        return rest
      })
      toast.success(`Timings saved for ${store.name}`)
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not save the timings")
    } finally {
      setSavingId("")
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const kpis = useMemo(
    () => [
      { label: "Stores", value: total },
      { label: "POS online", value: summary.posOnline },
      { label: "App open", value: summary.customerOpen },
      { label: "Instant live", value: summary.instantLive },
    ],
    [total, summary],
  )

  return (
    <div className="mx-auto max-w-[1400px] p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900">App timings &amp; store status</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Control when each store takes online orders and instant delivery · {today()} · times are store time (IST)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {kpis.map((k) => (
            <span key={k.label} className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-500">
              {k.label} <b className="ml-1 text-neutral-900">{k.value}</b>
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
          <Clock className="h-4 w-4 text-primary" /> App timings &amp; store status
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">
          The customer app takes orders from a store while it is inside the timings you set below and the store&apos;s own hours. Where
          &ldquo;Require POS online&rdquo; is ticked, that store&apos;s POS must also be online. Instant delivery goes live inside the
          instant timings. Changes reach customers within a few seconds.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search stores"
            aria-label="Search stores"
            className="h-10 w-full rounded-full border border-neutral-300 bg-white pl-9 pr-3 text-sm outline-none focus:border-primary"
          />
        </div>
        <select
          value={zoneId}
          onChange={(e) => setZoneId(e.target.value)}
          aria-label="Zone"
          className="h-10 rounded-full border border-neutral-300 bg-white px-3 text-sm text-neutral-700 outline-none focus:border-primary"
        >
          <option value="">All zones</option>
          {zones.map((z) => (
            <option key={z._id || z.id} value={z._id || z.id}>{z.name || z.zoneName}</option>
          ))}
        </select>
        <span className="ml-auto text-xs text-neutral-400">
          {updatedAt ? `Live · updated ${updatedAt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}
        </span>
      </div>

      <div className="mt-4 space-y-4">
        {loading ? (
          <div className="py-16 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-neutral-300" /></div>
        ) : stores.length === 0 ? (
          <div className="rounded-2xl border border-neutral-200 bg-white py-16 text-center text-neutral-500">No stores found.</div>
        ) : (
          stores.map((store) => (
            <StoreCard
              key={store.id}
              store={store}
              draft={drafts[store.id]}
              onDraft={onDraft}
              onSave={onSave}
              saving={savingId === store.id}
            />
          ))
        )}
      </div>

      {!loading && total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-end gap-2 text-sm">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="h-9 rounded-lg border border-neutral-300 px-3 font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
          >
            Prev
          </button>
          <span className="min-w-[90px] text-center text-neutral-600">Page {page} of {totalPages}</span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="h-9 rounded-lg border border-neutral-300 px-3 font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
