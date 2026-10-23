import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@food/components/ui/dialog"
import { RANGES, formatDateTime, modeLabel, money, rangeParams, statusTone } from "./posUsersUtils"

/**
 * One POS user's tracking: what they rang up, the registers they opened and closed, the cash they
 * moved and when they signed in. Opened from a row on the POS users screen.
 */

const TABS = [
  ["bills", "Bills"],
  ["shifts", "Registers"],
  ["cash", "Cash in / out"],
  ["logins", "Sign-ins"],
]

const TONE = {
  green: "border-emerald-200 bg-emerald-50 text-emerald-700",
  red: "border-rose-200 bg-rose-50 text-rose-700",
  gray: "border-neutral-200 bg-neutral-50 text-neutral-500",
}

function Pill({ tone, children }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${TONE[tone] || TONE.gray}`}>{children}</span>
}

function Kpi({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-3">
      <p className="text-[11px] font-medium text-neutral-500">{label}</p>
      <p className="mt-1 text-lg font-bold text-neutral-900">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-neutral-400">{hint}</p> : null}
    </div>
  )
}

function Empty({ children }) {
  return <p className="py-10 text-center text-sm text-neutral-500">{children}</p>
}

function Table({ head, children }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-neutral-200">
      <table className="w-full min-w-[520px] text-left text-sm">
        <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            {head.map((h, i) => (
              <th key={h} className={`px-3 py-2.5 font-medium ${i === head.length - 1 && head.right ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">{children}</tbody>
      </table>
    </div>
  )
}

export default function PosUserActivity({ user, onClose }) {
  const [range, setRange] = useState("30d")
  const [tab, setTab] = useState("bills")
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!user) return undefined
    let cancelled = false
    setLoading(true)
    adminAPI
      .getPosUserActivity(user.id, rangeParams(range))
      .then((res) => {
        if (!cancelled) setData(res?.data?.data || null)
      })
      .catch((error) => {
        if (!cancelled) toast.error(error?.response?.data?.message || "Failed to load activity")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user, range])

  useEffect(() => {
    if (user) {
      setData(null)
      setTab("bills")
    }
  }, [user])

  const s = data?.stats
  const modes = Object.entries(s?.byMode || {})

  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto p-5 sm:max-w-3xl sm:p-6">
        <DialogHeader className="pr-8">
          <DialogTitle className="text-lg font-bold text-neutral-900">{user?.name}</DialogTitle>
          <DialogDescription>
            {user?.username} · {user?.restaurantName}
            {data?.user?.lastLoginAt ? ` · last sign-in ${formatDateTime(data.user.lastLoginAt)}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Date range">
          {RANGES.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={range === key}
              onClick={() => setRange(key)}
              className={`h-8 rounded-full border px-3.5 text-xs font-medium transition-colors ${
                range === key ? "border-primary bg-primary text-white" : "border-neutral-300 text-neutral-600 hover:bg-neutral-50"
              }`}
            >
              {label}
            </button>
          ))}
          {loading ? <Loader2 className="h-4 w-4 animate-spin text-neutral-400" /> : null}
        </div>

        {!data ? (
          <div className="py-16 text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-neutral-300" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Kpi label="Bills" value={s.bills} hint={s.cancelled ? `${s.cancelled} cancelled` : undefined} />
              <Kpi label="Sales" value={money(s.sales)} />
              <Kpi label="Average bill" value={money(s.avgBill)} />
              <Kpi label="Pay later (due)" value={money(s.due)} />
            </div>
            {modes.length ? (
              <div className="flex flex-wrap gap-2 text-xs text-neutral-500">
                {modes.map(([mode, amount]) => (
                  <span key={mode} className="rounded-full border border-neutral-200 bg-white px-3 py-1">
                    {modeLabel(mode)} <b className="ml-1 text-neutral-900">{money(amount)}</b>
                  </span>
                ))}
              </div>
            ) : null}

            <div className="flex gap-1 border-b border-neutral-200" role="tablist">
              {TABS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  onClick={() => setTab(key)}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
                    tab === key ? "border-primary text-neutral-900" : "border-transparent text-neutral-500 hover:text-neutral-700"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === "bills" ? (
              data.bills.length === 0 ? (
                <Empty>No bills in this period.</Empty>
              ) : (
                <>
                  <Table head={["Bill", "Customer", "Paid by", "Status", "Total", "When"]}>
                    {data.bills.map((b) => (
                      <tr key={b.id}>
                        <td className="px-3 py-2.5 font-mono text-[13px] text-neutral-800">{b.billNo}</td>
                        <td className="px-3 py-2.5 text-neutral-600">{b.customerName || "Walk-in"}</td>
                        <td className="px-3 py-2.5 text-neutral-600">{modeLabel(b.paymentMode)}</td>
                        <td className="px-3 py-2.5"><Pill tone={statusTone(b.status)}>{b.status.replace(/_/g, " ")}</Pill></td>
                        <td className="px-3 py-2.5 font-medium text-neutral-900">{money(b.total)}{b.due ? <span className="ml-1 text-[11px] text-amber-700">({money(b.due)} due)</span> : null}</td>
                        <td className="px-3 py-2.5 text-neutral-500">{formatDateTime(b.at)}</td>
                      </tr>
                    ))}
                  </Table>
                  {s.bills + s.cancelled > data.bills.length ? (
                    <p className="text-xs text-neutral-400">Showing the latest {data.bills.length} bills.</p>
                  ) : null}
                </>
              )
            ) : null}

            {tab === "shifts" ? (
              data.shifts.length === 0 ? (
                <Empty>No registers opened or closed in this period.</Empty>
              ) : (
                <Table head={["Register", "Did", "Opened", "Closed", "Opening", "Counted", "Difference"]}>
                  {data.shifts.map((x) => (
                    <tr key={x.id}>
                      <td className="px-3 py-2.5 font-mono text-[13px] text-neutral-800">{x.code}</td>
                      <td className="px-3 py-2.5 capitalize text-neutral-600">{x.role.join(" & ") || "—"}</td>
                      <td className="px-3 py-2.5 text-neutral-500">{formatDateTime(x.openedAt)}</td>
                      <td className="px-3 py-2.5 text-neutral-500">{x.status === "open" ? <Pill tone="green">Open now</Pill> : formatDateTime(x.closedAt)}</td>
                      <td className="px-3 py-2.5 text-neutral-700">{money(x.openingCash)}</td>
                      <td className="px-3 py-2.5 text-neutral-700">{x.countedCash == null ? "—" : money(x.countedCash)}</td>
                      <td className="px-3 py-2.5">
                        {x.difference == null ? "—" : <Pill tone={x.difference === 0 ? "green" : "red"}>{x.difference === 0 ? "Balanced" : money(x.difference)}</Pill>}
                      </td>
                    </tr>
                  ))}
                </Table>
              )
            ) : null}

            {tab === "cash" ? (
              data.movements.length === 0 ? (
                <Empty>No cash moved in or out in this period.</Empty>
              ) : (
                <Table head={["When", "Register", "Type", "Amount"]}>
                  {data.movements.map((m, i) => (
                    <tr key={`${m.at}-${i}`}>
                      <td className="px-3 py-2.5 text-neutral-500">{formatDateTime(m.at)}</td>
                      <td className="px-3 py-2.5 font-mono text-[13px] text-neutral-800">{m.shiftCode}</td>
                      <td className="px-3 py-2.5"><Pill tone={m.type === "in" ? "green" : "red"}>{m.type === "in" ? "Cash in" : "Cash out"}</Pill></td>
                      <td className="px-3 py-2.5 font-medium text-neutral-900">{money(m.amount)}</td>
                    </tr>
                  ))}
                </Table>
              )
            ) : null}

            {tab === "logins" ? (
              data.logins.length === 0 ? (
                <Empty>No sign-ins recorded yet.</Empty>
              ) : (
                <Table head={["When", "Device", "IP"]}>
                  {data.logins.map((l, i) => (
                    <tr key={`${l.at}-${i}`}>
                      <td className="px-3 py-2.5 text-neutral-700">{formatDateTime(l.at)}</td>
                      <td className="px-3 py-2.5 text-neutral-600">{l.system || "Unknown device"}</td>
                      <td className="px-3 py-2.5 font-mono text-[13px] text-neutral-500">{l.ip || "—"}</td>
                    </tr>
                  ))}
                </Table>
              )
            ) : null}

            <p className="text-[11px] text-neutral-400">
              Counts bills and registers made while signed in as this POS user. Work done by the store owner, or before POS users existed, is not included.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
