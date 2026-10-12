import { useState, useEffect, useCallback } from "react"
import { toast } from "sonner"
import { Plus, Clock, Loader2, Pencil, Archive, RotateCcw, X } from "lucide-react"
import { adminAPI } from "@food/api"

/**
 * Delivery slots — the windows a customer can book instead of "as soon as you
 * can". Instant is not one of these: an order with no slot goes out now, the
 * way it always has, so an empty list here simply means no scheduling is on
 * offer and nothing else about ordering changes.
 */

const DAYS = [
  { value: 1, short: "Mon" },
  { value: 2, short: "Tue" },
  { value: 3, short: "Wed" },
  { value: 4, short: "Thu" },
  { value: 5, short: "Fri" },
  { value: 6, short: "Sat" },
  { value: 0, short: "Sun" },
]

const emptyForm = () => ({
  label: "",
  startTime: "07:00",
  endTime: "08:00",
  // The cutoff is entered as hours + minutes and combined into a single
  // minutes value for the API. Both blank means "use the system default".
  cutoffHours: "",
  cutoffMins: "",
  capacity: "",
  daysOfWeek: [],
  sortOrder: 0,
})

// hours + minutes inputs → the single minutes value the API stores. Both
// blank leaves it to the default (null); any entry counts as an explicit 0+.
const cutoffToMinutes = (hours, mins) => {
  if (String(hours).trim() === "" && String(mins).trim() === "") return null
  return (Number(hours) || 0) * 60 + (Number(mins) || 0)
}

// stored minutes → { hours, mins } for the edit form; null stays blank.
const minutesToCutoff = (total) => {
  if (total == null || total === "") return { cutoffHours: "", cutoffMins: "" }
  const n = Number(total)
  return { cutoffHours: String(Math.floor(n / 60)), cutoffMins: String(n % 60) }
}

/** "07:00" → "7:00 AM", so the list reads the way the customer will see it. */
const pretty = (hhmm) => {
  const [h, m] = String(hhmm || "").split(":").map(Number)
  if (!Number.isFinite(h)) return hhmm || ""
  const period = h >= 12 ? "PM" : "AM"
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${period}`
}

const describeDays = (days) =>
  !days?.length ? "Every day" : DAYS.filter((d) => days.includes(d.value)).map((d) => d.short).join(", ")

const describeCutoff = (minutes) => {
  const n = Number(minutes ?? 60)
  if (!n) return "Orders taken right up to the start"
  if (n % 60 === 0) return `Orders close ${n / 60}h before`
  return `Orders close ${n} min before`
}

export default function DeliverySlots() {
  const [slots, setSlots] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [form, setForm] = useState(emptyForm)

  const loadSlots = useCallback(async () => {
    setLoading(true)
    try {
      // Retired slots are shown too, greyed out — a slot that vanished from the
      // screen but still names old orders is the confusing version.
      const res = await adminAPI.getDeliverySlots({ includeInactive: true, withCoverage: true })
      setSlots(res?.data?.data?.slots || [])
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to load delivery slots")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSlots()
  }, [loadSlots])

  const openCreate = () => {
    setEditingId(null)
    setForm(emptyForm())
    setShowForm(true)
  }

  const openEdit = (slot) => {
    setEditingId(slot.id)
    setForm({
      label: slot.label || "",
      startTime: slot.startTime || "07:00",
      endTime: slot.endTime || "08:00",
      ...minutesToCutoff(slot.cutoffMinutes),
      capacity: slot.capacity ?? "",
      daysOfWeek: slot.daysOfWeek || [],
      sortOrder: slot.sortOrder || 0,
    })
    setShowForm(true)
  }

  const closeForm = () => {
    setShowForm(false)
    setEditingId(null)
    setForm(emptyForm())
  }

  const toggleDay = (value) =>
    setForm((prev) => ({
      ...prev,
      daysOfWeek: prev.daysOfWeek.includes(value)
        ? prev.daysOfWeek.filter((d) => d !== value)
        : [...prev.daysOfWeek, value],
    }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.label.trim()) {
      toast.error("Give the slot a name customers will recognise")
      return
    }
    setSaving(true)
    try {
      const body = {
        label: form.label.trim(),
        startTime: form.startTime,
        endTime: form.endTime,
        // Blank leaves it to the system default, which is derived from the
        // delivery promise rather than pinned here.
        cutoffMinutes: cutoffToMinutes(form.cutoffHours, form.cutoffMins),
        // Blank means uncapped, which is not the same as a capacity of zero.
        capacity: form.capacity === "" ? null : Number(form.capacity),
        daysOfWeek: form.daysOfWeek,
        sortOrder: Number(form.sortOrder) || 0,
      }
      if (editingId) {
        await adminAPI.updateDeliverySlot(editingId, body)
        toast.success("Slot updated")
      } else {
        await adminAPI.createDeliverySlot(body)
        toast.success("Slot added — customers can book it now")
      }
      closeForm()
      loadSlots()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to save the slot")
    } finally {
      setSaving(false)
    }
  }

  const handleRetire = async (slot) => {
    setBusyId(slot.id)
    try {
      await adminAPI.retireDeliverySlot(slot.id)
      toast.success("Slot retired — orders already booked into it are unaffected")
      loadSlots()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to retire the slot")
    } finally {
      setBusyId(null)
    }
  }

  const handleRestore = async (slot) => {
    setBusyId(slot.id)
    try {
      await adminAPI.updateDeliverySlot(slot.id, { isActive: true })
      toast.success("Slot is back on offer")
      loadSlots()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to restore the slot")
    } finally {
      setBusyId(null)
    }
  }

  const active = slots.filter((s) => s.isActive)
  const retired = slots.filter((s) => !s.isActive)

  const renderRow = (slot) => (
    <div
      key={slot.id}
      data-testid="delivery-slot-row"
      className={`flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 border-b border-slate-100 last:border-b-0 ${
        slot.isActive ? "" : "opacity-60"
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold text-slate-900">{slot.label}</p>
          <span className="text-xs font-medium text-slate-600 bg-slate-100 rounded-full px-2 py-0.5">
            {pretty(slot.startTime)} – {pretty(slot.endTime)}
          </span>
          {!slot.isActive && (
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 bg-slate-200 rounded px-1.5 py-0.5">
              Retired
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500 mt-1">
          {describeDays(slot.daysOfWeek)} · {describeCutoff(slot.cutoffMinutes)} ·{" "}
          {slot.capacity ? `${slot.capacity} orders max` : "No limit on orders"}
        </p>
        {/* Ordering into a window is deliberately not blocked by a shop's
            counter hours — an early round exists because the counter is shut.
            That leaves nothing to say when a window nobody can serve gets
            published, so it is said here. */}
        {slot.isActive && slot.coverage && slot.coverage.total > 0 ? (
          slot.coverage.open === 0 ? (
            <p className="mt-1 text-xs font-medium text-red-600">
              No shop is open during this window — orders will still be accepted for it.
            </p>
          ) : slot.coverage.open < slot.coverage.total ? (
            <p className="mt-1 text-xs text-amber-700">
              {slot.coverage.open} of {slot.coverage.total} shops are open during this window.
            </p>
          ) : null
        ) : null}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => openEdit(slot)}
          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 flex items-center gap-1.5"
        >
          <Pencil className="w-3.5 h-3.5" />
          Edit
        </button>
        {slot.isActive ? (
          <button
            type="button"
            onClick={() => handleRetire(slot)}
            disabled={busyId === slot.id}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
          >
            {busyId === slot.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />}
            Retire
          </button>
        ) : (
          <button
            type="button"
            onClick={() => handleRestore(slot)}
            disabled={busyId === slot.id}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
          >
            {busyId === slot.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            Restore
          </button>
        )}
      </div>
    </div>
  )

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center">
              <Clock className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Delivery Slots</h1>
              <p className="text-sm text-slate-500">
                The windows customers can book a delivery into. Ordering without a slot still means
                right away, so adding slots here offers scheduling without changing instant delivery.
              </p>
            </div>
          </div>

          <button
            onClick={showForm ? closeForm : openCreate}
            data-testid="add-slot-toggle"
            className="px-4 py-2.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-2 transition-all shadow-md"
          >
            {showForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            {showForm ? "Cancel" : "Add Slot"}
          </button>
        </div>

        {showForm && (
          <form onSubmit={handleSubmit} className="mt-6 border-t border-slate-200 pt-6 space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Name
                </label>
                <input
                  type="text"
                  value={form.label}
                  data-testid="slot-label"
                  onChange={(e) => setForm((p) => ({ ...p, label: e.target.value }))}
                  placeholder="e.g. Morning 7–8 AM"
                  className="w-full px-3 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Starts
                </label>
                <input
                  type="time"
                  value={form.startTime}
                  data-testid="slot-start"
                  onChange={(e) => setForm((p) => ({ ...p, startTime: e.target.value }))}
                  className="w-full px-3 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Ends
                </label>
                <input
                  type="time"
                  value={form.endTime}
                  data-testid="slot-end"
                  onChange={(e) => setForm((p) => ({ ...p, endTime: e.target.value }))}
                  className="w-full px-3 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Orders close (before window starts)
                </label>
                <div className="flex items-stretch gap-2">
                  <div className="flex-1 relative">
                    <input
                      type="number"
                      min="0"
                      value={form.cutoffHours}
                      data-testid="slot-cutoff-hours"
                      onChange={(e) => setForm((p) => ({ ...p, cutoffHours: e.target.value }))}
                      placeholder="0"
                      className="w-full pl-3 pr-10 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none">hrs</span>
                  </div>
                  <div className="flex-1 relative">
                    <input
                      type="number"
                      min="0"
                      max="59"
                      value={form.cutoffMins}
                      data-testid="slot-cutoff-mins"
                      onChange={(e) => setForm((p) => ({ ...p, cutoffMins: e.target.value }))}
                      placeholder="0"
                      className="w-full pl-3 pr-10 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none">min</span>
                  </div>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
                  How long before the window starts you stop taking orders for it.
                  Leave both blank to use the default.
                </p>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                  Orders per day (optional)
                </label>
                <input
                  type="number"
                  min="1"
                  value={form.capacity}
                  data-testid="slot-capacity"
                  onChange={(e) => setForm((p) => ({ ...p, capacity: e.target.value }))}
                  placeholder="Leave blank for no limit"
                  className="w-full px-3 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Once this many orders are booked for a day, the slot shows as full.
                </p>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                Runs on
              </label>
              <div className="flex flex-wrap gap-2">
                {DAYS.map((day) => {
                  const on = form.daysOfWeek.includes(day.value)
                  return (
                    <button
                      key={day.value}
                      type="button"
                      onClick={() => toggleDay(day.value)}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-full border transition-colors ${
                        on
                          ? "bg-blue-600 border-blue-600 text-white"
                          : "bg-white border-slate-300 text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {day.short}
                    </button>
                  )
                })}
              </div>
              <p className="text-[11px] text-slate-500 mt-1.5">
                Pick none to run the slot every day.
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={closeForm}
                className="px-4 py-2.5 text-sm font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                data-testid="save-slot"
                className="px-4 py-2.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {editingId ? "Save changes" : "Add slot"}
              </button>
            </div>
          </form>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-slate-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading slots…
          </div>
        ) : slots.length === 0 ? (
          <div className="py-16 text-center px-6">
            <Clock className="w-8 h-8 text-slate-300 mx-auto mb-3" />
            <p className="text-sm font-semibold text-slate-700">No delivery slots yet</p>
            <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
              Customers are ordering for immediate delivery. Add a slot to let them choose a
              window instead — morning and evening rounds, for instance.
            </p>
          </div>
        ) : (
          <>
            {active.map(renderRow)}
            {retired.length > 0 && (
              <>
                <div className="px-4 py-2 bg-slate-50 border-y border-slate-100">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    Retired ({retired.length})
                  </p>
                </div>
                {retired.map(renderRow)}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
