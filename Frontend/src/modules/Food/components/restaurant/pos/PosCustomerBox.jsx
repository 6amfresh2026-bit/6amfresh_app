import { useEffect, useRef, useState } from "react"
import { X, ChevronDown, Pencil } from "lucide-react"
import { usePosApi } from "./posApiContext"
import PosNewCustomerModal from "./PosNewCustomerModal"

/**
 * "Walk in Customer" — the customer picker.
 *
 * Empty means an anonymous walk-in. Typing digits looks a phone up anywhere;
 * typing letters looks a name up among this shop's own customers. The pencil
 * opens the full customer record, which is saved on its own — someone who
 * filled in a birthday and a GSTIN meant to create a customer, not to attach
 * one to whatever bill happens to be open.
 */
export default function PosCustomerBox({ customer, onChange }) {
  const api = usePosApi()
  const [q, setQ] = useState("")
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const timer = useRef(null)

  useEffect(() => {
    clearTimeout(timer.current)
    const needle = q.trim()
    if (needle.length < 2) { setResults([]); return undefined }
    timer.current = setTimeout(async () => {
      try {
        const res = await api.posSearchCustomers(needle)
        setResults(Array.isArray(res?.data?.data) ? res.data.data : [])
        setOpen(true)
      } catch {
        setResults([])
      }
    }, 250)
    return () => clearTimeout(timer.current)
  }, [q])

  const label = customer ? `${customer.name || "Customer"}${customer.phone ? ` · ${customer.phone}` : ""}` : ""

  return (
    <div className="relative flex w-[27%] min-w-[260px] items-stretch gap-1.5">
      <div className="relative flex flex-1 items-center rounded border border-gray-300 bg-white">
        <input
          value={customer ? label : q}
          readOnly={Boolean(customer)}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Walk in Customer"
          className="h-10 w-full bg-transparent px-3 text-[15px] text-gray-800 outline-none placeholder:text-gray-700"
        />
        {customer || q ? (
          <button type="button" className="px-1 text-gray-500 hover:text-gray-800" onClick={() => { onChange(null); setQ(""); setResults([]) }} aria-label="Clear customer">
            <X size={14} />
          </button>
        ) : null}
        <span className="px-2 text-gray-500"><ChevronDown size={16} /></span>
        {open && results.length > 0 ? (
          <ul className="absolute left-0 top-full z-30 mt-1 w-full rounded border border-gray-200 bg-white shadow-lg">
            {results.map((c) => (
              <li
                key={c.id}
                onMouseDown={() => { onChange(c); setQ(""); setOpen(false) }}
                className="cursor-pointer px-3 py-2 text-sm hover:bg-sky-50"
              >
                <span className="font-medium text-gray-800">{c.name || "Unnamed"}</span>
                <span className="ml-2 text-gray-500">{c.phone}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <button type="button" onClick={() => setEditing(true)} className="rounded bg-gray-200 px-3 text-gray-700 hover:bg-gray-300" title="Add / edit customer">
        <Pencil size={16} />
      </button>

      {editing ? (
        <PosNewCustomerModal
          initial={customer}
          onClose={() => setEditing(false)}
          onSaved={(c) => { onChange(c); setEditing(false); setQ("") }}
        />
      ) : null}
    </div>
  )
}
