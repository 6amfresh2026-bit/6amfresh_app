import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2, Search, Check, AlertCircle, X, UserPlus, MapPin } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"
import { loadGooglePlaces, addressFromPlace, geocodeAddress } from "@food/utils/googlePlaces"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@food/components/ui/dialog"

/**
 * Starts a subscription for a customer who phoned the shop.
 *
 * The form only ever offers choices the server will accept: products the
 * seller marked subscribable, and addresses that belong to the chosen
 * customer. Anything the server would refuse is either absent from the list or
 * disabled with the reason on it — the alternative is an admin filling in six
 * fields and being told "no" by a toast.
 */

const WEEKDAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
]

const FREQUENCIES = [
  { value: "daily", label: "Daily", hint: "Every day" },
  { value: "weekly", label: "Weekly", hint: "Chosen weekdays" },
  { value: "monthly", label: "Monthly", hint: "One day a month" },
]

const PAYMENT_METHODS = [
  { value: "cash", label: "Cash on delivery" },
  { value: "wallet", label: "Wallet" },
  { value: "razorpay", label: "Online" },
]

/** Local YYYY-MM-DD. toISOString() would shift the day for any timezone behind UTC. */
const toDateInput = (date) => {
  const d = new Date(date)
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const errMsg = (err, fallback) => err?.response?.data?.message || err?.message || fallback

/** "07:00" → "7:00 AM", so a slot reads the way the customer sees it. */
const prettyTime = (hhmm) => {
  const [h, m] = String(hhmm || "").split(":").map(Number)
  if (!Number.isFinite(h)) return hhmm || ""
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`
}

const labelCls = "mb-1.5 block text-xs font-medium text-neutral-600"
const fieldCls =
  "h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-800 outline-none focus:border-pink-400 disabled:bg-neutral-50 disabled:text-neutral-400"

const Hint = ({ children }) => (
  <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-700">
    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
    <span>{children}</span>
  </p>
)

const emptyNewCustomer = {
  name: "",
  phone: "",
  flatNumber: "",
  street: "",
  city: "",
  state: "",
  zipCode: "",
  lat: null,
  lng: null,
}

const emptyForm = {
  restaurantId: "",
  itemId: "",
  quantity: 1,
  frequency: "daily",
  daysOfWeek: [],
  dayOfMonth: 1,
  deliveryTime: "06:00",
  // Empty means the plain time above is being used — which is how this form
  // worked before slots existed, and still how it works where none are set up.
  deliverySlotId: "",
  startDate: toDateInput(new Date()),
  addressId: "",
  paymentMethod: "cash",
}

export default function AddSubscriptionDialog({ open, onOpenChange, onCreated }) {
  const [customer, setCustomer] = useState(null)
  // A number that has never used the app: the account is made along with the
  // subscription, from these fields, instead of picking an existing customer.
  const [isNew, setIsNew] = useState(false)
  const [newCust, setNewCust] = useState(emptyNewCustomer)
  const [form, setForm] = useState(emptyForm)
  const [submitting, setSubmitting] = useState(false)

  const [addresses, setAddresses] = useState([])
  const [addressesLoading, setAddressesLoading] = useState(false)
  const [restaurants, setRestaurants] = useState([])
  const [products, setProducts] = useState([])
  const [productsLoading, setProductsLoading] = useState(false)
  const [slots, setSlots] = useState([])

  const set = useCallback((patch) => setForm((f) => ({ ...f, ...patch })), [])

  const reset = useCallback(() => {
    setCustomer(null)
    setIsNew(false)
    setNewCust(emptyNewCustomer)
    setForm(emptyForm)
    setAddresses([])
    setProducts([])
  }, [])

  useEffect(() => {
    if (!open) return
    adminAPI
      .getRestaurants({ limit: 1000 })
      .then((r) => setRestaurants(r?.data?.data?.restaurants || r?.data?.restaurants || []))
      .catch((err) => toast.error(errMsg(err, "Could not load stores")))
  }, [open])

  // The windows on offer. A shop with none configured keeps the plain time
  // field, so this form does not become unusable by adding slots to the system.
  useEffect(() => {
    if (!open) return
    adminAPI
      .getDeliverySlots()
      .then((r) => {
        const list = r?.data?.data?.slots || []
        setSlots(list)
        // Pre-pick the first window rather than opening on "Custom time",
        // which would leave the slot list looking optional when it is the
        // way the shop means deliveries to be booked.
        if (list.length) set({ deliverySlotId: list[0].id })
      })
      .catch(() => setSlots([]))
  }, [open, set])

  // Addresses belong to the customer, so they can only be loaded once one is picked.
  useEffect(() => {
    if (!customer?.id) {
      setAddresses([])
      return
    }
    setAddressesLoading(true)
    adminAPI
      .getCustomerAddresses(customer.id)
      .then((res) => {
        const list = res?.data?.data?.addresses || []
        setAddresses(list)
        // Pre-pick the address the customer themselves defaults to, as long as
        // it is one an order can actually be written to.
        const usable = list.find((a) => a.isDefault && a.hasLocation) || list.find((a) => a.hasLocation)
        set({ addressId: usable ? usable.id : "" })
      })
      .catch((err) => toast.error(errMsg(err, "Could not load addresses")))
      .finally(() => setAddressesLoading(false))
  }, [customer?.id, set])

  // Only products the chosen store has marked subscribable.
  useEffect(() => {
    if (!form.restaurantId) {
      setProducts([])
      return
    }
    setProductsLoading(true)
    adminAPI
      .getFoods({ restaurantId: form.restaurantId, subscriptionEnabled: "true", limit: 500 })
      .then((res) => setProducts(res?.data?.data?.foods || []))
      .catch((err) => toast.error(errMsg(err, "Could not load products")))
      .finally(() => setProductsLoading(false))
  }, [form.restaurantId])

  const usableAddresses = addresses.filter((a) => a.hasLocation)

  const newCustProblem = useMemo(() => {
    if (digitsOnly(newCust.phone).length !== 10) return "Enter a 10-digit mobile number"
    if (!newCust.name.trim()) return "Enter the customer's name"
    if (!newCust.street.trim() || !newCust.city.trim() || !newCust.state.trim()) {
      return "The address needs a street, city and state"
    }
    // A position typed by hand has to be a real one. An empty position is fine here:
    // it is looked up from the address when the subscription is started.
    const { lat, lng } = newCust
    if ((lat == null) !== (lng == null)) return "Enter both latitude and longitude, or neither"
    if (lat != null && (Math.abs(lat) > 90 || Math.abs(lng) > 180)) return "Latitude or longitude is out of range"
    return null
  }, [newCust])

  const problem = useMemo(() => {
    if (isNew) {
      if (newCustProblem) return newCustProblem
    } else {
      if (!customer) return "Pick a customer"
      if (!addressesLoading && addresses.length === 0) return "This customer has no saved address"
      if (!addressesLoading && usableAddresses.length === 0) return "None of this customer's addresses has a map location"
    }
    if (!form.restaurantId) return "Pick a store"
    if (!productsLoading && form.restaurantId && products.length === 0) return "This store has no subscribable products"
    if (!form.itemId) return "Pick a product"
    if (!isNew && !form.addressId) return "Pick a delivery address"
    if (form.frequency === "weekly" && form.daysOfWeek.length === 0) return "Pick at least one weekday"
    if (!(Number(form.quantity) >= 1)) return "Quantity must be at least 1"
    return null
  }, [isNew, newCustProblem, customer, addresses, addressesLoading, usableAddresses.length, form, products.length, productsLoading])

  const submit = async () => {
    if (problem) return
    setSubmitting(true)
    try {
      let pin = { lat: newCust.lat, lng: newCust.lng }
      if (isNew && (pin.lat == null || pin.lng == null)) {
        // Typed rather than picked: place it on the map now, because an address
        // with no position cannot be delivered to.
        const full = [newCust.flatNumber, newCust.street, newCust.city, newCust.state, newCust.zipCode]
          .map((part) => part.trim())
          .filter(Boolean)
          .join(", ")
        const found = await geocodeAddress(full)
        if (!found) {
          toast.error(
            "Could not find this address on the map. Pick one of the suggestions in the address search, or enter its latitude and longitude.",
          )
          return
        }
        pin = found
        setNewCust((c) => ({ ...c, ...found }))
      }
      const payload = {
        ...(isNew
          ? {
              newCustomer: {
                name: newCust.name.trim(),
                phone: digitsOnly(newCust.phone),
                address: {
                  flatNumber: newCust.flatNumber.trim(),
                  street: newCust.street.trim(),
                  city: newCust.city.trim(),
                  state: newCust.state.trim(),
                  zipCode: newCust.zipCode.trim(),
                  lat: pin.lat,
                  lng: pin.lng,
                },
              },
            }
          : { customerId: customer.id, addressId: form.addressId }),
        restaurantId: form.restaurantId,
        itemId: form.itemId,
        quantity: Number(form.quantity),
        frequency: form.frequency,
        ...(form.deliverySlotId
          ? { deliverySlotId: form.deliverySlotId }
          : { deliveryTime: form.deliveryTime }),
        startDate: form.startDate,
        paymentMethod: form.paymentMethod,
        ...(form.frequency === "weekly" ? { daysOfWeek: form.daysOfWeek } : {}),
        ...(form.frequency === "monthly" ? { dayOfMonth: Number(form.dayOfMonth) } : {}),
      }
      const res = await adminAPI.createProductSubscription(payload)
      const created = res?.data?.data?.subscription
      toast.success(`Subscription started for ${created?.customer?.name || (isNew ? newCust.name : customer.name)}`)
      reset()
      onOpenChange(false)
      onCreated?.(created)
    } catch (err) {
      toast.error(errMsg(err, "Could not start the subscription"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      {/* p-0 + flex column, so the header and the action bar stay put and only
          the form scrolls. With padding on the content itself, a tall form
          pushes the submit button off the bottom of the screen. */}
      {/* 4xl is wider than a tablet viewport, and the shared DialogContent drops
          its side margin above `sm` — so cap it lower until there is room for
          the two columns, or the dialog sits edge to edge. */}
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl lg:max-w-4xl">
        {/* pr-12 keeps the text clear of the close button Radix pins top-right. */}
        <DialogHeader className="border-b border-neutral-200 px-5 py-3.5 pr-14">
          <DialogTitle>New subscription</DialogTitle>
          <DialogDescription className="mt-0.5">
            Set up on the customer's behalf — they can pause or cancel it in the app.
          </DialogDescription>
        </DialogHeader>

        {/* Two columns: who it goes to on the left, what and when on the right.
            Stacked, this form is taller than a laptop screen. */}
        <div className="grid flex-1 gap-x-6 gap-y-5 overflow-y-auto px-5 py-4 lg:grid-cols-2">
          {/* Left — who it goes to */}
          <div className="space-y-4">
            {isNew ? (
              <NewCustomerFields
                value={newCust}
                onChange={(patch) => setNewCust((c) => ({ ...c, ...patch }))}
                onBack={() => {
                  setIsNew(false)
                  setNewCust(emptyNewCustomer)
                }}
              />
            ) : (
              <CustomerPicker
                customer={customer}
                onPick={setCustomer}
                onAddNew={(term) => {
                  const digits = digitsOnly(term)
                  setNewCust({
                    ...emptyNewCustomer,
                    phone: digits.length >= 8 ? digits.slice(-10) : "",
                    name: digits ? "" : term.trim(),
                  })
                  setIsNew(true)
                }}
              />
            )}

            {!isNew && customer && (
              <div>
                <span className={labelCls}>Deliver to</span>
                {addressesLoading ? (
                  <div className="flex h-10 items-center gap-2 text-sm text-neutral-500">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading addresses…
                  </div>
                ) : addresses.length === 0 ? (
                  <Hint>
                    {customer.name} has no saved address. They need to add one in the app before a
                    subscription can be delivered.
                  </Hint>
                ) : (
                  <>
                    <div className="space-y-2">
                      {addresses.map((a) => (
                        <label
                          key={a.id}
                          className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm ${
                            form.addressId === a.id ? "border-pink-400 bg-pink-50/50" : "border-neutral-200"
                          } ${a.hasLocation ? "" : "cursor-not-allowed opacity-60"}`}
                        >
                          <input
                            type="radio"
                            name="subscription-address"
                            className="mt-1 accent-pink-500"
                            checked={form.addressId === a.id}
                            disabled={!a.hasLocation}
                            onChange={() => set({ addressId: a.id })}
                          />
                          <span className="min-w-0">
                            <span className="font-medium text-neutral-800">{a.label}</span>
                            {a.isDefault && (
                              <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600">
                                Default
                              </span>
                            )}
                            <span className="block text-neutral-600">{a.line}</span>
                            {!a.hasLocation && (
                              <span className="block text-xs text-amber-700">
                                No map location saved — an order cannot be delivered here
                              </span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                    {usableAddresses.length === 0 && (
                      <Hint>
                        None of these has a map location. The customer needs to re-select the address on
                        the map in the app.
                      </Hint>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Right — what and when */}
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <span className={labelCls}>Store</span>
                <select
                  className={fieldCls}
                  value={form.restaurantId}
                  onChange={(e) => set({ restaurantId: e.target.value, itemId: "" })}
                >
                  <option value="">Select a store</option>
                  {restaurants.map((r) => (
                    <option key={r._id || r.id} value={r._id || r.id}>
                      {r.restaurantName || r.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <span className={labelCls}>Product</span>
                <select
                  className={fieldCls}
                  value={form.itemId}
                  disabled={!form.restaurantId || productsLoading}
                  onChange={(e) => set({ itemId: e.target.value })}
                >
                  <option value="">
                    {productsLoading ? "Loading…" : form.restaurantId ? "Select a product" : "Pick a store first"}
                  </option>
                  {products.map((p) => (
                    <option key={p._id || p.id} value={p._id || p.id}>
                      {p.name} · ₹{p.price}
                    </option>
                  ))}
                </select>
                {form.restaurantId && !productsLoading && products.length === 0 && (
                  <Hint>
                    This store has no products marked for subscription. Turn on "Subscription" on a
                    product first.
                  </Hint>
                )}
              </div>

              <div>
                <span className={labelCls}>Quantity</span>
                <input
                  type="number"
                  min={1}
                  className={fieldCls}
                  value={form.quantity}
                  onChange={(e) => set({ quantity: e.target.value })}
                />
              </div>

              <div>
                <span className={labelCls}>Delivery time</span>
                {slots.length > 0 ? (
                  <select
                    className={fieldCls}
                    data-testid="subscription-slot"
                    value={form.deliverySlotId}
                    onChange={(e) => set({ deliverySlotId: e.target.value })}
                  >
                    {slots.map((slot) => (
                      <option key={slot.id} value={slot.id}>
                        {slot.label} ({prettyTime(slot.startTime)} – {prettyTime(slot.endTime)})
                      </option>
                    ))}
                    <option value="">Custom time…</option>
                  </select>
                ) : null}
                {slots.length === 0 || !form.deliverySlotId ? (
                  <input
                    type="time"
                    className={slots.length > 0 ? `${fieldCls} mt-2` : fieldCls}
                    value={form.deliveryTime}
                    onChange={(e) => set({ deliveryTime: e.target.value })}
                  />
                ) : null}
              </div>
            </div>

            <div>
              <span className={labelCls}>Repeats</span>
              <div className="grid grid-cols-3 gap-2">
                {FREQUENCIES.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    onClick={() => set({ frequency: f.value })}
                    className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                      form.frequency === f.value
                        ? "border-pink-400 bg-pink-50 text-pink-700"
                        : "border-neutral-200 text-neutral-700 hover:bg-neutral-50"
                    }`}
                  >
                    <span className="block font-medium">{f.label}</span>
                    <span className="block text-xs text-neutral-500">{f.hint}</span>
                  </button>
                ))}
              </div>

              {form.frequency === "weekly" && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {WEEKDAYS.map((d) => {
                    const on = form.daysOfWeek.includes(d.value)
                    return (
                      <button
                        key={d.value}
                        type="button"
                        onClick={() =>
                          set({
                            daysOfWeek: on
                              ? form.daysOfWeek.filter((v) => v !== d.value)
                              : [...form.daysOfWeek, d.value].sort((a, b) => a - b),
                          })
                        }
                        className={`h-9 w-12 rounded-lg border text-sm transition ${
                          on
                            ? "border-pink-400 bg-pink-500 text-white"
                            : "border-neutral-200 text-neutral-700 hover:bg-neutral-50"
                        }`}
                      >
                        {d.label}
                      </button>
                    )
                  })}
                </div>
              )}

              {form.frequency === "monthly" && (
                <div className="mt-3 max-w-[220px]">
                  <span className={labelCls}>Day of the month</span>
                  <select
                    className={fieldCls}
                    value={form.dayOfMonth}
                    onChange={(e) => set({ dayOfMonth: e.target.value })}
                  >
                    {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                  {/* 29-31 are missing on purpose: a subscription on the 30th would
                      skip February entirely. */}
                  <p className="mt-1 text-xs text-neutral-500">Days run to 28 so every month has one.</p>
                </div>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <span className={labelCls}>First delivery</span>
                <input
                  type="date"
                  min={toDateInput(new Date())}
                  className={fieldCls}
                  value={form.startDate}
                  onChange={(e) => set({ startDate: e.target.value })}
                />
              </div>
              <div>
                <span className={labelCls}>Payment</span>
                <select
                  className={fieldCls}
                  value={form.paymentMethod}
                  onChange={(e) => set({ paymentMethod: e.target.value })}
                >
                  {PAYMENT_METHODS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="items-center gap-3 border-t border-neutral-200 bg-neutral-50/60 px-5 py-3 sm:justify-between">
          <span className={`text-xs ${problem ? "text-amber-700" : "text-emerald-700"}`}>
            {problem || "Ready to start"}
          </span>
          <button
            type="button"
            disabled={Boolean(problem) || submitting}
            onClick={submit}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-pink-500 px-5 text-sm font-medium text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Start subscription
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Finds the customer by name or phone — the two things whoever answers the
 * phone has in hand.
 */
function CustomerPicker({ customer, onPick, onAddNew }) {
  const [term, setTerm] = useState("")
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const timer = useRef(null)

  useEffect(() => {
    clearTimeout(timer.current)
    const needle = term.trim()
    if (customer || needle.length < 2) {
      setResults([])
      return undefined
    }
    setLoading(true)
    timer.current = setTimeout(async () => {
      try {
        const res = await adminAPI.getCustomers({ search: needle, limit: 8 })
        const data = res?.data?.data || res?.data
        setResults(data?.customers || data?.users || [])
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => clearTimeout(timer.current)
  }, [term, customer])

  if (customer) {
    return (
      <div>
        <span className={labelCls}>Customer</span>
        <div className="flex items-center justify-between rounded-lg border border-pink-200 bg-pink-50/50 px-3 py-2.5">
          <span className="text-sm">
            <span className="font-medium text-neutral-900">{customer.name}</span>
            <span className="ml-2 text-neutral-600">{customer.phone}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              onPick(null)
              setTerm("")
            }}
            className="rounded p-1 text-neutral-500 hover:bg-white hover:text-neutral-800"
            aria-label="Change customer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <span className={labelCls}>Customer</span>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search by name or phone"
          className={`${fieldCls} pl-9`}
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-neutral-400" />
        )}
      </div>

      {results.length > 0 && (
        <ul className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-neutral-200">
          {results.map((c) => (
            <li key={c._id || c.id}>
              <button
                type="button"
                onClick={() =>
                  onPick({
                    id: String(c._id || c.id),
                    name: c.name || "Unnamed",
                    phone: c.phone || "",
                  })
                }
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-pink-50"
              >
                <span className="font-medium text-neutral-800">{c.name || "Unnamed"}</span>
                <span className="text-neutral-500">{c.phone}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {term.trim().length >= 2 && !loading && results.length === 0 && (
        <p className="mt-2 text-xs text-neutral-500">No customer matches "{term.trim()}"</p>
      )}
      {/* The phone-in customer who has never used the app: make the account here. */}
      <button
        type="button"
        onClick={() => onAddNew(term)}
        className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-pink-600 hover:text-pink-700"
      >
        <UserPlus className="h-4 w-4" />
        {term.trim().length >= 2 && !loading && results.length === 0
          ? "Add as a new customer"
          : "New number? Add a new customer"}
      </button>
    </div>
  )
}

const digitsOnly = (value) => String(value || "").replace(/\D/g, "")

/**
 * Name, number and delivery address for a customer who has no account yet.
 *
 * The address comes from a Google Places search rather than free text, because an
 * order cannot be delivered to an address with no map position and a typed one has
 * none. The street, city, state and pin are filled from the pick and stay editable.
 */
function NewCustomerFields({ value, onChange, onBack }) {
  const inputRef = useRef(null)
  const [mapsError, setMapsError] = useState("")

  useEffect(() => {
    let autocomplete
    let cancelled = false
    loadGooglePlaces()
      .then((places) => {
        if (cancelled || !inputRef.current) return
        autocomplete = new places.Autocomplete(inputRef.current, {
          componentRestrictions: { country: "in" },
          fields: ["formatted_address", "geometry", "address_components", "name"],
        })
        autocomplete.addListener("place_changed", () => {
          const parsed = addressFromPlace(autocomplete.getPlace())
          if (parsed) onChange(parsed)
        })
      })
      .catch((err) => setMapsError(err?.message || "Address search is unavailable"))
    return () => {
      cancelled = true
      if (autocomplete && window.google?.maps?.event) window.google.maps.event.clearInstanceListeners(autocomplete)
    }
    // onChange is a fresh closure each render; the search box only needs wiring once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pinned = value.lat != null && value.lng != null

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className={labelCls + " mb-0"}>New customer</span>
        <button type="button" onClick={onBack} className="text-xs font-medium text-neutral-500 hover:text-neutral-800">
          Search existing instead
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className={labelCls}>Mobile number</span>
          <input
            inputMode="numeric"
            maxLength={14}
            className={fieldCls}
            placeholder="10-digit number"
            value={value.phone}
            onChange={(e) => onChange({ phone: e.target.value })}
          />
        </div>
        <div>
          <span className={labelCls}>Name</span>
          <input
            className={fieldCls}
            placeholder="Customer name"
            value={value.name}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </div>
      </div>

      <div>
        <span className={labelCls}>Delivery address</span>
        <div className="relative">
          <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          <input
            ref={inputRef}
            className={`${fieldCls} pl-9`}
            placeholder="Search the address, society or landmark"
            autoComplete="off"
          />
        </div>
        {mapsError && <Hint>{mapsError}. The address cannot be pinned without it.</Hint>}
        {pinned ? (
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-700">
            <Check className="h-3.5 w-3.5" /> Pinned on the map ({value.lat.toFixed(5)}, {value.lng.toFixed(5)})
          </p>
        ) : (
          <p className="mt-1.5 text-xs text-neutral-500">
            Pick a suggestion to pin it. If you type the address below instead, it is looked up on the map when you
            start the subscription.
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className={labelCls}>Flat / house no.</span>
          <input className={fieldCls} value={value.flatNumber} onChange={(e) => onChange({ flatNumber: e.target.value })} />
        </div>
        <div>
          <span className={labelCls}>Pin code</span>
          <input className={fieldCls} value={value.zipCode} onChange={(e) => onChange({ zipCode: e.target.value })} />
        </div>
      </div>
      <div>
        <span className={labelCls}>Street / area</span>
        <input className={fieldCls} value={value.street} onChange={(e) => onChange({ street: e.target.value })} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className={labelCls}>City</span>
          <input className={fieldCls} value={value.city} onChange={(e) => onChange({ city: e.target.value })} />
        </div>
        <div>
          <span className={labelCls}>State</span>
          <input className={fieldCls} value={value.state} onChange={(e) => onChange({ state: e.target.value })} />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className={labelCls}>Latitude (optional)</span>
          <input
            type="number"
            step="any"
            className={fieldCls}
            value={value.lat ?? ""}
            onChange={(e) => onChange({ lat: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </div>
        <div>
          <span className={labelCls}>Longitude (optional)</span>
          <input
            type="number"
            step="any"
            className={fieldCls}
            value={value.lng ?? ""}
            onChange={(e) => onChange({ lng: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </div>
      </div>
      <p className="text-xs text-neutral-500">
        An account is made for this number. When they sign in to the app with it, the subscription and address are
        already there.
      </p>
    </div>
  )
}
