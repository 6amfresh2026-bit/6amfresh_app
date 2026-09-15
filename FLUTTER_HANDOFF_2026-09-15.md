# Flutter handoff — 15 Sep 2026

What changed today, why, and what each app has to do about it.

A **delta**, like the ones before it. The full contracts stay where they are:

| App | Spec |
|---|---|
| Customer | [FLUTTER_API_SPEC.md](FLUTTER_API_SPEC.md) |
| Rider | [DELIVERY_API_SPEC.md](DELIVERY_API_SPEC.md) |
| Seller | [RESTAURANT_API_SPEC.md](RESTAURANT_API_SPEC.md) |
| Yesterday's delta | [FLUTTER_HANDOFF_2026-09-14.md](FLUTTER_HANDOFF_2026-09-14.md) |

Backend suite: **410 tests passing.** 44 commits.

Today splits into four pieces of work and one buried surprise:

1. **Expiry dates** — a product can now go off, and stops being sellable when it does.
2. **Delivery radius** — an admin sets how far each store delivers.
3. **Own-fleet dispatch** — a seller's orders go to the seller's own riders.
4. **Accept-first dispatch** — a rider waits for the seller, but only for three
   minutes. §3.2, and it changes what `unassigned` means in every app.
5. **The background queues have never run.** §5. Read it.

---

## 0. The thing that changes the most for you

**Live rider tracking has never worked.** Not "was flaky" — the rider's
location was written into Redis and then dropped on the floor. The worker that
copies it into MongoDB could not reach Redis at all, so it took an early exit
and reported every job as completed.

If a tracking map in any app has ever looked frozen, stale, or seemed to fall
back to a last-known position that never changed, **this is why**, and it is
fixed. `deliveryPartner.lastLocation` and `order.lastRiderLocation` now
actually move.

Nothing in the API shape changes. Behaviour does: data you may have written
off as unreliable is now real, so anything built to work around it —
interpolation, hiding the map, socket-only tracking with no persistence
fallback — is worth revisiting.

---

## 1. Customer app

### 1.1 A store that will not deliver to you is not shown

Each seller now carries `deliveryRadiusKm`, set by an admin. The zone already
said *which block* a store serves; this says *how far into it* the store will
actually go — a zone can be tens of kilometres across, and a store at one edge
was taking orders for the far side and promising ten minutes.

`GET /food/restaurant/restaurants` — when `lat` and `lng` are sent, stores
whose radius does not reach the customer are **not in the list at all**.

Two changes worth knowing:

- **It applies to every listing now**, not only when you sort by distance or
  pass `radiusKm`. It used to ride on the geo query, and the default listing
  sends neither — so out-of-range stores appeared there and were refused at
  checkout.
- **`distanceInKm` can be `null`.** Distance is computed per store rather than
  through `$geoNear`, so a store with no coordinates yet is no longer silently
  dropped from results — it is listed with `distanceInKm: null` and sorted
  last. Render that as unknown, not as `0 km`.

`deliveryRadiusKm` is `0` for every store until an admin sets one, and `0`
means no limit, so nothing changes until it is configured.

### 1.2 Ordering too far away is refused, with the distance

`POST /food/orders` → **400**:

> `This store delivers within 2 km. That address is about 10.0 km away.`

Show it verbatim. *"Outside the delivery area"* reads as a bug to somebody
standing just past the line and tells support nothing.

This sits alongside the existing zone refusals, which are unchanged:

| Message | Cause |
|---|---|
| `We don't deliver to this address yet` | Address is in no zone |
| `This seller does not deliver to the selected address` | Address is in a different zone |
| `This store delivers within N km. That address is about X km away.` | **New** — inside the block, outside the radius |

A saved address the customer picked weeks ago is judged fresh at checkout, so
this can refuse an order for a store they have used before — the store's radius
may have changed since.

### 1.3 Expired stock cannot be ordered

`POST /food/orders` → **400**:

> `Amul Milk 1L is past its expiry date and cannot be sold`

Deliberately not *"out of stock"*: that would send the customer back to wait
for a restock that is not coming, and hides the real problem from the shop.

In practice a customer should rarely see it — an hourly sweep takes expired
products off the storefront (`isAvailable: false`), so they normally disappear
before anyone adds them to a cart. The refusal is the backstop for the gap
between expiry and the next sweep, and for an item sitting in an old cart.

`expiryDate` is already exposed on menu items (`null` for anything that does
not expire). Showing it is optional; for grocery it is worth showing on
perishables.

---

## 2. Rider app

### 2.1 An order can now be *given* to you, not only offered

A seller with their own riders no longer uses the shared pool. Their orders go
straight to one of their own riders — one named person, no race, no countdown.

That path was already there for manual assignment, and it emits the same event
you already handle:

```
order_assigned   -> this order is yours, head to the store
```

What is new is that it now fires **automatically**, not just when a human picks
you. Before today, a seller who linked even one rider lost automatic dispatch
altogether and every order waited for somebody to assign it by hand.

**The practical difference from `new_order`:** there is no acceptance
countdown, nothing to win, and no other rider competing. The order is in your
list. Do not render it as a race.

### 2.2 But you now have a deadline to accept it

**This is the one that needs real work in the app.**

An order assigned to you and never accepted goes back to the fleet after
`FLEET_ACCEPT_TIMEOUT_MINUTES` — **3 minutes by default**. You are then
skipped for that order, so it cannot bounce straight back to you.

You are told, on an event that already exists:

```jsonc
// order_deassigned
{
  "orderId": "...",
  "orderMongoId": "...",
  "order_id": "FOD-7441949850",
  "reason": "Not accepted in time"
}
```

Handle it, or the order simply vanishes from the rider's list — which reads as
a bug to them and as a missing order to whoever they ask about it.

Three minutes rather than the pool's 45 seconds, on purpose: the pool is a race
between strangers where somebody slow simply loses, while this rider was
*given* the order and is expected to take it. Long enough to finish parking,
short enough that a rider who has gone home does not hold it all evening.

### 2.3 The same event fires when the order dies under you

`order_deassigned` is no longer only about your accept deadline. It now also
arrives when the order is cancelled while you are holding it, which is a real
window: a rider is dispatched three minutes in, and an order the seller never
answers is cancelled at four.

The `reason` field says which:

| `reason` | What happened |
|---|---|
| `Not accepted in time` | You did not accept inside your window (§2.2) |
| `The customer cancelled this order` | Customer cancelled while you were on the way |
| `The store did not accept this order` | The shop never answered and it was auto-cancelled |

Before this, two of those three told the rider nothing at all — the order
simply vanished from the list, or worse, did not, and the rider arrived at the
shop for an order that no longer existed. **Handle all three the same way:
take it off the list and say why.**

### 2.4 How the order reached you is now recorded

`order.dispatch` gains two fields:

| Field | Values | Meaning |
|---|---|---|
| `assignmentMode` | `auto` \| `fleet` \| `manual` \| `null` | How it was dispatched |
| `assignedByRole` | `ADMIN` \| `RESTAURANT` \| `null` | Who, when a person did it |

- `fleet` — handed to one named rider from the seller's own riders.
- `auto` — broadcast to the shared pool and raced (set at broadcast time).
- `manual` — a person chose, and `assignedByRole` says which.

Useful in the app for one thing in particular: a `fleet` or `manual` order
should never show an acceptance countdown, and an `auto` one should.

### 2.5 Who a fleet order goes to

Only for context, since the app does not decide it:

- The seller's own riders, **online**, approved.
- **Carrying nothing** wins. A rider mid-delivery is only considered once
  nobody is free, and then only if the batching rules from yesterday agree.
- Nearest to the store breaks ties.
- A rider whose GPS has gone quiet is ranked **last**, not excluded — Doze
  stops the location upload, and the alternative is an order nobody delivers.
- Anyone de-assigned from that order, or who let the accept window lapse, is
  skipped for it.

With nobody free, the order **waits** rather than going to another shop's
rider. An admin is alerted after ~6 attempts, and either the seller or an admin
can assign by hand.

---

## 3. Seller app

### 3.1 Own-fleet sellers get automatic dispatch back

The headline: **linking a rider used to cost you automatic dispatch entirely.**
`restaurantUsesManualDispatch()` returned true if a seller had any linked
rider, and dispatch skipped the order — so owning riders made delivery slower
than owning none.

Now the seller's orders go to the seller's riders, automatically — once the
seller has accepted the order, or once the wait in §3.2 runs out.

An order sitting `unassigned` therefore means one of two things now: the seller
has not answered it yet, or every one of their riders is busy or offline. The
first is the ordinary case for the first few minutes of an order's life.

### 3.2 A rider is no longer sent until the seller accepts

**Changed after this document was first written.** A rider used to be
dispatched the moment the customer paid, in parallel with the seller answering.
They now wait for Accept.

The reasoning: a rider sent to a shop that then declines has ridden for
nothing, and one standing in a shop that has not started picking is worse than
one who arrives a minute later.

The cap is what stops that becoming the old failure. After
`SELLER_ACCEPT_DISPATCH_MINUTES` — **3 by default** — a rider is sent whether or
not anybody has tapped anything, so a seller who has left the tablet in the
back room no longer silently holds the order until it is cancelled.

What this means for the seller app:

- **Accept is now the thing that starts the delivery.** It was always worth
  prompting; it now has a direct, visible consequence.
- An order in its first three minutes with no rider is **normal**, not stuck.
- Manual assignment (§3.3) still works during that window and short-circuits
  the wait entirely.

Two operational notes, because they are easy to get wrong in a deployment:

- **The scheduler must be running** (`npm run start:scheduler`). The fallback
  is swept there every 30 seconds. With BullMQ disabled — which is this
  project's own default — nothing else will ever send an unaccepted order.
- Setting the acceptance window (`orderAcceptanceTimeMinutes`, 4 by default)
  **below 3 makes the fallback unreachable**, because the order is
  auto-cancelled before the rider is sent.

### 3.3 Manual assignment still works, unchanged

```
GET  /food/restaurant/delivery-fleet
POST /food/restaurant/orders/:orderId/assign-delivery   { deliveryPartnerId }
```

Still limited to the seller's own fleet. It now records
`assignmentMode: 'manual'`, `assignedByRole: 'RESTAURANT'`.

The fleet list carries `activeOrderCount` per rider, which is what to sort and
grey out by.

### 3.4 Cancelling a collected order no longer restocks it

Cancellation outranks every other status, so a seller or an admin can cancel an
order a rider picked up ten minutes ago. Every one of those paths used to put
the units straight back on the shelf — and they are in a bag on a bike, so the
shop believed it had cover it did not have and sold the same stock twice.

A post-pickup cancellation now leaves the count alone and logs what is
outstanding. **If the app shows stock, do not assume a cancellation returns
it.** Returning goods is a physical act; somebody has to book them in.

This was not caused by today's work — it has been quietly inflating counts on
every post-pickup cancellation for as long as the paths have existed. Products
showing impossible quantities are worth auditing; the fix stops new drift, it
does not correct old.

### 3.5 Expiry on products

If the seller app has a product form, `expiryDate` is accepted on
`PATCH /food/restaurant/foods/:id` — send `YYYY-MM-DD`, or `""` to clear it.
An unparseable date is refused with *"Expiry date is invalid"* rather than
silently saved as null.

Two rules worth mirroring in the UI:

- **Batch-tracked products ignore it.** When `manageMultipleBatch` is on, each
  intake carries its own expiry and the picker reads those. A product-level
  date there is a second answer to the same question, so disable the field.
- A past date takes the product off the storefront within the hour.
  **Correcting the date puts it back automatically** — no need to also toggle
  availability, and telling the seller to do so would be wrong.

---

## 4. Admin (web, listed for completeness)

New endpoints, none of them Flutter-facing:

| Endpoint | Purpose |
|---|---|
| `GET /food/admin/sellers/:id/fleet` | Who is on this shop's fleet, plus unassigned riders |
| `POST /food/admin/sellers/:id/fleet` | Put a rider on a shop |
| `DELETE /food/admin/sellers/:id/fleet/:riderId` | Take them off |
| `GET /food/admin/orders/:id/assignable-riders` | Riders for this order, own-fleet first |
| `POST /food/admin/orders/:id/assign-delivery` | Assign **any** rider — the escalation path |

Admin also sets `deliveryRadiusKm` on the seller, and `expiryDate` on products.

---

## 5. The background queues have never run

Worth its own section because of how much it explains.

Four separate faults, all with the same shape — the job was picked up, failed
or quietly did nothing, and was then **logged as completed**:

1. **The order processor could not load its own service.** Three imports
   pointed one directory too high, so every order job threw *Cannot find
   module*.
2. **The order, payment and maintenance workers never connected to MongoDB.**
   Each job failed ten seconds later with a buffering timeout.
3. **The tracking worker never connected to Redis.** BullMQ brings its own
   connection for the queue, which is not the app's client — so the handler
   took its `if (!redis) return` exit and wrote nothing. (§0)
4. **`logger.debug` did not exist**, and one caller sits inside a `catch`,
   where the thrown TypeError replaced the error being reported.

What this means in practice, in any deployment with `BULLMQ_ENABLED=true`:

- **Rider tracking never persisted** (§0).
- **Dispatch retries never ran** — an order nobody accepted was never
  re-offered by the queue.
- **Scheduled orders were never activated** by the queue, and acceptance
  timeouts never fired through it.
- **Payment jobs never credited a wallet.**
- **Subscription billing and FSSAI expiry never ran.** If BullMQ was on, past
  months' subscription invoices are likely missing — worth checking against
  the billing records rather than assuming.

All four are fixed, and there are now two harnesses that run the real workers
and assert real effects rather than job status:
`Backend/scripts/queue-e2e.mjs` and `Backend/scripts/tracking-e2e.mjs`.

---

## 6. Configuration added today

| Env | Default | Controls |
|---|---|---|
| `FLEET_ACCEPT_TIMEOUT_MINUTES` | 3 | How long a named rider has to accept |
| `FLEET_ESCALATE_AFTER_ATTEMPTS` | 6 | When an admin is told a fleet has nobody free |
| `SELLER_ACCEPT_DISPATCH_MINUTES` | 3 | How long an order waits for Accept before a rider is sent anyway |

Per-record, not env: `restaurant.deliveryRadiusKm` (0 = no limit) and
`item.expiryDate` (null = does not expire).

---

## 7. Open decisions

Product calls, flagged so they are chosen rather than discovered:

1. **A date-only expiry expires at UTC midnight**, so *"expires 15 Sep"* stops
   selling at 05:30 IST on the 15th — about a day of sellable stock written
   off per item. This codebase already decided the opposite convention for
   coupons (`endOfOfferWindow` treats midnight as *through that day*). The fix
   only makes sense applied to batch expiry as well, which shipped yesterday,
   so it is a deliberate change rather than a slip to patch quietly.
2. **A rider now waits for the seller.** This reverses a deliberate earlier
   choice — picking and the ride to the shop used to happen in parallel, and
   the code said so in as many words. It trades some of that speed for not
   sending riders to orders that are about to be declined, and the three-minute
   cap bounds the loss. Worth measuring against the promise report once there
   is data.
3. **A fleet order never falls back to the shared pool.** Correct — another
   shop's rider should not cover a delivery this shop staffed — but it means
   an order can wait on an admin. The alert at ~6 attempts is the safety net.
4. **Three minutes to accept** is a guess. Worth revisiting once there is data
   on how long riders actually take.
5. **The coupon list endpoint still does not carry slabs**, unchanged from
   yesterday's §8.

## 8. Still missing

- **Purchase orders / GRN.** Receiving exists; there is no supplier or PO.
- **Live ops console.** Nothing shows orders breaching promise, idle vs busy
  riders, ageing unassigned orders, or current stockouts. More visible now
  that a fleet order can sit waiting.
