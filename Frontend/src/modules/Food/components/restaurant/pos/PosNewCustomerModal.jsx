import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { usePosApi } from "./posApiContext"
import PosModal from "./PosModal"

/**
 * The customer record a counter keeps.
 *
 * Only a name and a mobile number are required, because that is all a cashier
 * has time to ask for with someone waiting. Everything else — birthday,
 * address, GSTIN — is what a shop fills in later for a regular, and the save
 * never blanks a field left empty, so a quick edit does not throw away what
 * was captured before.
 *
 * Verify looks the number up before the form is filled in. The same customer
 * gets entered again and again at a counter under slightly different names,
 * and phone is this system's identity for a customer — so catching it early
 * turns a duplicate into an edit.
 */

const GST_TYPES = [
  { value: "unregistered", label: "UnRegistered" },
  { value: "registered", label: "Registered" },
  { value: "composition", label: "Composition" },
]

// India-only today; the field exists so a printed address reads completely.
const COUNTRIES = ["India"]

const STATES = [
  "Andhra Pradesh", "Assam", "Bihar", "Chhattisgarh", "Delhi", "Goa", "Gujarat", "Haryana",
  "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra",
  "Odisha", "Punjab", "Rajasthan", "Tamil Nadu", "Telangana", "Uttar Pradesh", "Uttarakhand",
  "West Bengal",
]

const label = "mb-1.5 block text-[15px] text-gray-800"
const field =
  "h-11 w-full rounded border border-gray-300 bg-white px-3 text-[15px] text-gray-800 outline-none focus:border-sky-400 placeholder:text-gray-400"

// Defined at module scope, not inside the modal: a component declared inside
// another re-renders as a brand-new type on every keystroke, so React remounts
// its <input> and the field loses focus after a single character.
function Phone({ code, onCode, value, onValue, placeholder }) {
  return (
    <div className="flex">
      <select
        value={code}
        onChange={(e) => onCode(e.target.value)}
        className="h-11 shrink-0 rounded-l border border-r-0 border-gray-300 bg-neutral-100 px-2 text-[15px] text-gray-800 outline-none"
      >
        {["+91"].map((c) => <option key={c} value={c}>🇮🇳 {c}</option>)}
      </select>
      <input
        className={`${field} rounded-l-none`}
        value={value}
        onChange={(e) => onValue(e.target.value)}
        placeholder={placeholder}
        inputMode="numeric"
      />
    </div>
  )
}

const empty = {
  name: "",
  countryCode: "+91",
  phone: "",
  whatsappCountryCode: "+91",
  whatsappPhone: "",
  dateOfBirth: "",
  anniversary: "",
  email: "",
  addressLine1: "",
  country: "India",
  state: "Gujarat",
  city: "",
  pinCode: "",
  gstType: "unregistered",
  gstin: "",
}

export default function PosNewCustomerModal({ initial, onClose, onSaved }) {
  const api = usePosApi()
  const [form, setForm] = useState({
    ...empty,
    ...(initial ? { name: initial.name || "", phone: initial.phone || "" } : {}),
  })
  const [saving, setSaving] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verified, setVerified] = useState(null) // null | 'new' | 'existing'

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const digits = (v) => String(v || "").replace(/\D/g, "")

  const phoneOk = digits(form.phone).length === 10
  const registered = form.gstType !== "unregistered"
  const problem =
    !form.name.trim() ? "Name is required"
      : !phoneOk ? "Enter a 10-digit mobile number"
        : registered && !form.gstin.trim() ? "A registered customer needs a GSTIN"
          : null

  const verify = async () => {
    if (!phoneOk) { toast.error("Enter a 10-digit mobile number first"); return }
    setVerifying(true)
    try {
      const res = await api.posLookupCustomer(digits(form.phone))
      const found = res?.data?.data
      if (found?.exists) {
        // Fill the form from the record rather than making the cashier retype
        // it — this is the moment a duplicate becomes an edit.
        const c = found.customer
        set({
          name: c.name || form.name,
          email: c.email || "",
          whatsappPhone: c.whatsappPhone || "",
          gstType: c.gstType || "unregistered",
          gstin: c.gstin || "",
          dateOfBirth: c.dateOfBirth ? String(c.dateOfBirth).slice(0, 10) : "",
          anniversary: c.anniversary ? String(c.anniversary).slice(0, 10) : "",
          addressLine1: c.addressLine1 || "",
          country: c.country || "India",
          state: c.state || form.state,
          city: c.city || "",
          pinCode: c.pinCode || "",
        })
        setVerified("existing")
        toast.success(`${c.name || "This customer"} already has an account — details loaded`)
      } else {
        setVerified("new")
        toast.success("This number is free")
      }
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not check that number")
    } finally {
      setVerifying(false)
    }
  }

  const save = async () => {
    if (problem) return
    setSaving(true)
    try {
      const res = await api.posSaveCustomer({ ...form, phone: digits(form.phone) })
      const saved = res?.data?.data?.customer
      toast.success(`${saved?.name || "Customer"} saved`)
      onSaved(saved)
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not save the customer")
    } finally {
      setSaving(false)
    }
  }

  return (
    <PosModal
      title={initial?.id ? "Customer" : "New Customer"}
      onClose={onClose}
      width="max-w-4xl"
      footer={
        <div className="space-y-2">
          {problem ? <p className="text-center text-sm text-rose-600">{problem}</p> : null}
          <button
            type="button"
            disabled={Boolean(problem) || saving}
            onClick={save}
            className="mx-auto block rounded bg-[#1f1f1f] px-8 py-2.5 text-[15px] font-medium text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      }
    >
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
        <div>
          <span className={label}>Name <span className="text-rose-500">*</span></span>
          <input className={field} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Name" autoFocus />
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[15px] text-gray-800">Mobile No. <span className="text-rose-500">*</span></span>
            <button
              type="button"
              onClick={verify}
              disabled={verifying}
              className="text-[14px] font-medium text-sky-600 hover:text-sky-700 disabled:opacity-50"
            >
              {verifying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Verify"}
            </button>
          </div>
          <Phone
            code={form.countryCode}
            onCode={(v) => set({ countryCode: v })}
            value={form.phone}
            onValue={(v) => { set({ phone: v }); setVerified(null) }}
            placeholder="Mobile No."
          />
          {verified === "existing" ? (
            <p className="mt-1 text-xs text-amber-700">Already a customer — saving updates them</p>
          ) : verified === "new" ? (
            <p className="mt-1 text-xs text-emerald-700">New number</p>
          ) : null}
        </div>

        <div>
          <span className={label}>WhatsApp No.</span>
          <Phone
            code={form.whatsappCountryCode}
            onCode={(v) => set({ whatsappCountryCode: v })}
            value={form.whatsappPhone}
            onValue={(v) => set({ whatsappPhone: v })}
            placeholder="WhatsApp No."
          />
        </div>

        <div>
          <span className={label}>Date Of Birth</span>
          <input type="date" className={field} value={form.dateOfBirth} onChange={(e) => set({ dateOfBirth: e.target.value })} />
        </div>
        <div>
          <span className={label}>Anniversary Date</span>
          <input type="date" className={field} value={form.anniversary} onChange={(e) => set({ anniversary: e.target.value })} />
        </div>
        <div>
          <span className={label}>Email</span>
          <input className={field} value={form.email} onChange={(e) => set({ email: e.target.value })} placeholder="Email Address" />
        </div>

        <div>
          <span className={label}>Address Line 1</span>
          <input className={field} value={form.addressLine1} onChange={(e) => set({ addressLine1: e.target.value })} placeholder="AddressLine1" />
        </div>
        <div>
          <span className={label}>Country</span>
          <select className={field} value={form.country} onChange={(e) => set({ country: e.target.value })}>
            {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <span className={label}>State</span>
          <select className={field} value={form.state} onChange={(e) => set({ state: e.target.value })}>
            {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div>
          <span className={label}>City</span>
          <input className={field} value={form.city} onChange={(e) => set({ city: e.target.value })} placeholder="City" />
        </div>
        <div>
          <span className={label}>Pin Code</span>
          <input className={field} value={form.pinCode} onChange={(e) => set({ pinCode: e.target.value })} placeholder="Pin Code" inputMode="numeric" />
        </div>
        <div>
          <span className={label}>GST Type</span>
          <select className={field} value={form.gstType} onChange={(e) => set({ gstType: e.target.value })}>
            {GST_TYPES.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
        </div>

        <div>
          <span className={label}>GSTIN{registered ? <span className="text-rose-500"> *</span> : null}</span>
          <input
            className={field}
            value={form.gstin}
            onChange={(e) => set({ gstin: e.target.value.toUpperCase() })}
            placeholder="GSTIN"
            disabled={!registered}
          />
          {!registered ? (
            <p className="mt-1 text-xs text-gray-500">Only a registered customer is billed against a GSTIN</p>
          ) : null}
        </div>
      </div>

      {/* An address typed here has no map pin, and a delivery needs one. Worth
          saying once rather than having it fail at the door later. */}
      {form.addressLine1 ? (
        <p className="mt-4 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
          This address is for the bill. A delivery to it needs the customer to pick it on the map in the app.
        </p>
      ) : null}
    </PosModal>
  )
}
