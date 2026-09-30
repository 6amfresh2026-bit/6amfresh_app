# Block batching — Flutter integration guide

_Verified against backend: 2026-09-30, tested end-to-end against a live
backend + real rider/customer/restaurant accounts (not just unit tests)._

This is a companion to `DELIVERY_API_SPEC.md` — read that for the full
delivery-partner API surface. This doc is only about **one feature**: a rider
who already has an order gets a second, nearby order from a *different*
seller pushed straight to them instead of a fresh rider being dispatched.
It covers the full flow end to end, the exact payload shapes, and — important
— a real bug this feature exposed in the "current trip" screen that the
Flutter app must not repeat.

---

## 1. What this feature actually is

**Before:** if a rider already had an order and hadn't picked it up yet, a
second order could only be pushed to them automatically if it was from the
**same restaurant** (one pickup serves both). A second order from a
*different* seller — even one 200m away — always went out to the whole rider
pool as a fresh dispatch, even if your rider was standing right next to it.

**Now:** if a rider has an accepted, not-yet-collected order, and a new order
comes in from a **different but nearby** seller (within ~1.5km of a pickup
already on the rider's plate, and the drop within ~1.5km of a drop already on
the rider's plate — same rule as same-store batching), the new order is
assigned **directly** to that rider. It never gets broadcast to the pool.
This is on top of same-store batching, not a replacement for it — same-store
batching is unchanged.

Caps that still apply either way:
- A rider can carry at most 3 active orders at once (`MAX_ACTIVE_ORDERS_PER_RIDER`).
- A rider will not be routed through more than 2 different sellers on one
  trip (`MAX_PICKUP_STOPS_PER_TRIP`) — a third different-store pickup is
  refused even if geographically close.
- A "priority"/quick order (the surcharge delivery mode) is **never** batched,
  either direction — it always rides alone, and nothing rides with it.
- Once a rider has **collected** (picked up) anything they're carrying,
  nothing more gets added — a new order at that point always goes back to
  the normal pool.

None of this is something the app decides — it's entirely server-side. The
app's job is: **show whatever orders the server says the rider is carrying,
and never assume there's only one.**

---

## 2. The flow, step by step

### Step 1 — Rider accepts order A normally
Nothing different here. `new_order` / `order_assigned` arrives, rider swipes
to accept, `PATCH /orders/:orderId/accept`, trip begins. Order A shows as the
active trip exactly as it always has.

### Step 2 — A nearby order B comes in from a different seller
This happens entirely on the server while the rider is still en route to
pickup order A. There is **no accept step for the rider** — the assignment is
made directly (`dispatch.status` goes straight to `accepted`, not
`assigned`). The rider was never asked; they were told.

### Step 3 — The app is notified
Two things fire, both fire-and-forget (a missed one isn't fatal — see §5):

**Socket event** `order_added_to_batch`, payload = the exact same
delivery-order-socket shape used by `order_assigned` / `new_order` (see
`DELIVERY_API_SPEC.md` for the full field list — `orderMongoId`, `orderId`,
`restaurantName`, `restaurantLocation`, `customerLocation`, `pricing`,
`dispatch`, etc.). There is no separate "batch" schema — treat this exactly
like `order_assigned`'s payload, just don't show an accept prompt for it.

**FCM push** (actionable alert, same delivery pattern as every other order
push):
```json
{
  "title": "Another order added to your trip",
  "body": "Order #FOD-xxxxxxxxxx was added to your current trip -- nearby pickup, same route.",
  "data": {
    "type": "order_added_to_batch",
    "orderId": "<mongo id>",
    "orderMongoId": "<mongo id>"
  }
}
```

### Step 4 — The rider now has 2 active orders
This is the part that matters most for the app. **Do not assume "current
trip" means one order.** See §3 below — this is exactly the bug found while
building this.

### Step 5 — Rider finishes order A, order B becomes "the" trip
Once order A is marked delivered, the very next call to
`GET /food/delivery/orders/current` returns order B as the primary/only
order — no special handling needed here, this falls out naturally once you've
fixed §3.

---

## 3. The bug this feature exposed — and why it matters for the app

`GET /food/delivery/orders/current` used to pick "the current order" by
**most recently updated**. That was fine when a rider only ever had one
order. The moment order B gets added mid-trip, order B's write makes it "more
recently updated" than order A — so **the endpoint would flip to showing
order B, and order A would vanish from the response entirely**, even though
the rider is still carrying it and still needs to go there.

This is now fixed server-side: the endpoint sorts by
**oldest-accepted-first**, so whichever order the rider committed to first
stays "the" primary trip until it's actually done. But the fix only works if
the app also surfaces the batch — otherwise the rider still doesn't know
order B exists until order A is finished (better than losing it, but the
whole point of this feature is one trip covering both).

### The response shape, updated

```json
GET /food/delivery/orders/current
→ data: {
    "activeOrder": {
      /* the full order object, exactly as documented in DELIVERY_API_SPEC.md */
      "_id": "...",
      "order_id": "FOD-3058134669",
      "restaurantId": { "restaurantName": "...", ... },
      "dispatch": { "status": "accepted", "assignmentMode": "auto", ... },
      ...

      /* NEW — only present when there's a batch, otherwise absent/undefined */
      "batchOrders": [
        {
          "_id": "6abcd648c651e0be856da61f",
          "order_id": "FOD-5202958659",
          "orderStatus": "preparing",
          "restaurantName": "Block Batch Test Store",
          "pricing": { "total": 157.6, ... }
        }
      ]
    }
  }
```

`batchOrders` is a **summary**, not the full order shape — just enough to
show the rider "you're also carrying this." When the rider taps into it (see
§4), fetch the real thing with `GET /food/delivery/orders/:orderId`.

`batchOrders` will contain more than one entry if a rider is carrying 3
orders (the max). Don't assume it's 0 or 1 — render it as a list.

---

## 4. What the Flutter app needs to do

**Required — don't ship without this:**

1. When `GET /food/delivery/orders/current` (or the `order_status_update` /
   recovery flow) returns `batchOrders` with items in it, show something on
   the active-trip screen telling the rider a second order is riding along —
   at minimum the restaurant name and order id per entry. The web app's
   version of this (for reference, not to copy pixel-for-pixel) is a small
   banner right under the restaurant header on the pickup screen:
   > "Another order added to your trip — #FOD-xxxx · Restaurant Name.
   > Finish this delivery first — it'll show up as your next trip."

2. Listen for `order_added_to_batch` on the socket and refresh the current
   trip (or just re-call `GET /food/delivery/orders/current`) so the banner
   appears live, not just after the app is reopened. Treat it like
   `order_status_update` for refresh purposes — **do not** route it through
   whatever "new order, swipe to accept" modal you use for `new_order` /
   `new_order_available` / `order_assigned`. There is nothing to accept; it's
   already the rider's.

3. Play a distinct (or at least *a*) notification sound/vibration for
   `order_added_to_batch` so the rider notices it happened mid-trip, same as
   you already do for `order_ready` etc. Don't reuse the full-screen
   "new order, 45 seconds to accept" alert UI — this isn't a race against
   other riders, there's no timer, and there's nothing to swipe.

**Recommended, not blocking:**

4. Let the rider tap a batched entry to preview it (items, drop address) even
   before it becomes their active trip — call
   `GET /food/delivery/orders/:orderId` for the full object.

5. On the map, it's reasonable to plot the second pickup pin too (greyed
   out / secondary marker) so the rider can see it's basically on the way,
   even though it isn't actionable yet.

**Do NOT build:** a full concurrent-multi-trip mode where the rider can
freely switch between two "at pickup" flows, mark either one up independently
out of order, etc. The backend still expects orders to be worked in the
order they were accepted — `dispatch.assignedAt` order. Build the banner and
the notification; the "next trip" hand-off is automatic once the current one
is marked delivered.

---

## 5. Edge cases and gotchas

- **A batched order can get bounced back to the pool after being assigned.**
  Two brand-new nearby orders can race for the same rider — both can pass the
  eligibility check before either write lands. If that happens, whichever one
  lost the tiebreak is released and goes back through normal dispatch
  (broadcast to the pool). The rider who "gained" it briefly will see an
  `order_deassigned` event for it. This is rare (a tight race window) but
  real — handle `order_deassigned` for an order that was never shown to you
  as a normal "new order" the same way you already do for a fleet
  reassignment: quietly remove it, no need to alert the rider loudly, they
  never acted on it.

  ⚠️ The payload on that `order_deassigned` says `"reason": "Not accepted in
  time"` even in this case — that string is reused from the existing
  fleet-timeout release path and is **not accurate** for a race-loss (the
  order genuinely was accepted, just lost a capacity race a moment later).
  Don't surface that reason text to the rider; a generic "order no longer
  yours" is safer until the backend gives this its own reason string.

- **Cross-store batching never happens for a fleet-linked rider.** If a rider
  is tied to one seller's own fleet (dark-store rider), they only ever get
  that seller's orders — this feature is structurally impossible for them.
  Nothing to handle here, just don't be surprised if it "never triggers" for
  a fleet tester account — that's correct, not a bug.

- **The batch is never bigger than the pickup-stop cap.** Don't design UI
  that assumes an unbounded list — 2 sellers max on one trip today
  (`MAX_PICKUP_STOPS_PER_TRIP`), so `batchOrders` plus the primary order is
  at most 2 entries in practice right now, though the field is shaped as a
  list so a future config bump doesn't need a client change.

- **A quick/priority order is invisible to this whole feature** — it never
  appears as a batch candidate and never receives one. If you're testing and
  a quick order doesn't batch, that's correct.

- **`batchOrders` entries do NOT include delivery/customer address or
  items** — it's a summary for the banner, not enough to act on. Fetch the
  full order via `GET /food/delivery/orders/:orderId` before letting the
  rider do anything with it beyond "I see it exists."

---

## Quick reference

| Question | Where it's answered |
|---|---|
| Did a second order just get added to my trip? | `order_added_to_batch` socket event, or `batchOrders` on `GET /orders/current` |
| Which order is "the" current trip right now? | Whichever the rider accepted **first** — `GET /orders/current` now sorts oldest-accepted-first, not most-recently-touched |
| What do I know about a batched order before it becomes active? | Only what's in its `batchOrders` summary — restaurant name, order id, status, pricing. Full detail needs its own `GET /orders/:orderId` call |
| My rider is carrying 2 orders — will they ever be offered a 3rd from a different store? | Only if under `MAX_PICKUP_STOPS_PER_TRIP` (2 sellers) and `MAX_ACTIVE_ORDERS_PER_RIDER` (3 orders) — otherwise no |
| I got `order_deassigned` for an order I never showed an accept prompt for | Almost certainly a batch-assignment race loss — quietly drop it, don't alert |

## Gotchas checklist

- [ ] `GET /food/delivery/orders/current` can return `activeOrder.batchOrders` — read it, don't assume one order.
- [ ] Listen for `order_added_to_batch` and refresh the trip screen live — don't wait for the next poll/app-reopen.
- [ ] `order_added_to_batch` is informational, not an offer — no accept modal, no countdown timer.
- [ ] Handle `order_deassigned` gracefully for an order you never actively showed — could be a batch race loss, not a mistake on your end.
- [ ] Don't build a "switch between two active pickups" UI — the backend still expects orders worked oldest-first; the hand-off to the next batched order is automatic once the current one is delivered.
