# Flutter handoff — 14 Sep 2026

What changed across the three apps today, why, and what each one has to do
about it.

A **delta**, not a replacement. The full contracts stay where they are:

| App | Spec |
|---|---|
| Customer | [FLUTTER_API_SPEC.md](FLUTTER_API_SPEC.md) |
| Rider | [DELIVERY_API_SPEC.md](DELIVERY_API_SPEC.md) |
| Seller | [RESTAURANT_API_SPEC.md](RESTAURANT_API_SPEC.md) |
| Delivery windows | [DELIVERY_SLOTS_API_SPEC.md](DELIVERY_SLOTS_API_SPEC.md) |
| Previous delta | [FLUTTER_HANDOFF_2026-09-12.md](FLUTTER_HANDOFF_2026-09-12.md) |

Backend suite: **355 tests passing.**

---

## 0. The one breaking change — read this first

**`item.quantity` on an order now means what is actually being delivered, not
what was ordered.**

A basket can go short at the shelf (§3). Every screen renders
`item.quantity`, so leaving it as the ordered figure meant a rider was told to
collect four when two were going, and an invoice printed 4 × ₹149 against a
bill charging for two. Measured before the fix: a line sum of ₹596 against a
subtotal of ₹298.

The two order serializers now restate lines:

| Field | Meaning |
|---|---|
| `quantity` | **What is being delivered.** Use this everywhere you used it before. |
| `orderedQuantity` | What the customer asked for. Only present when the line was adjusted. |
| `wasShortPicked` | `true` when fewer are arriving than were ordered. |

A line the shop could not supply at all is **removed from the array** — it is
not on the picking list and not on the bill. The order document still records
it, so it is not lost; it is just not part of the delivery.

```dart
// Anywhere a line is shown
final arriving = item['quantity'] as int;
final ordered  = item['orderedQuantity'] as int? ?? arriving;
if (item['wasShortPicked'] == true) {
  // "2 of 4 — the rest refunded"
}
```

Nothing changes for an order that never went short: `orderedQuantity` is
absent and `quantity` is what it always was.

---

## 1. Customer app

### 1.1 The delivery promise is now a real number, and it is recorded

The quote used to be distance alone. It now also counts **the rider's ride to
the store** and **how many doorsteps are already ahead of this one**, so it is
honest on a busy evening rather than optimistic exactly when it matters.

`POST /food/orders/calculate` → `data.pricing`:

| Field | Meaning |
|---|---|
| `deliveryPromiseMinutes` | The promise for the **selected** mode |
| `deliveryPromiseMinutesBasic` | What Basic would be |
| `deliveryPromiseMinutesQuick` | What Priority would be |

**Do not print a fixed band.** The web cart used to say "35-40 mins" and
"20-25 mins" directly under a header quoting six. Label both options from
these fields. Measured on a store owing 20 drops to one rider: Basic **14
min**, Priority **6 min** — the gap *is* the queue.

The promise is frozen onto the order at creation as `order.promise`:

```jsonc
"promise": {
  "quotedMinutes": 6,
  "quotedAt": "2026-09-14T06:50:13.658Z",
  "dueBy": "2026-09-14T06:56:13.658Z",   // quotedAt + quotedMinutes
  "distanceKm": 0.9,
  "outcome": "pending",                   // pending | on_time | late | not_applicable
  "varianceSeconds": null                 // signed; negative is early
}
```

Count down to `dueBy`. `outcome` settles when the order stops moving. A
cancelled order is `not_applicable`, never `late` — a cancellation is its own
failure.

### 1.2 Quick mode now buys something

It used to charge ₹15 and change nothing at all. A Priority order is now
**dispatched unbatched**: nothing is queued in front of it, and a rider
carrying one cannot pick up anything else. That mechanical difference is what
the surcharge pays for, and it is why `deliveryPromiseMinutesQuick` is lower.

### 1.3 A floor under the basket

There was no minimum order, no small-cart fee and no free-delivery threshold
anywhere — a ₹30 order was delivered at a loss. Both are **off until an admin
configures them**, so nothing changes for an existing install.

`data.pricing` gains:

| Field | Meaning |
|---|---|
| `smallCartFee` | Surcharge on this basket. Show it as **its own line**, not folded into the platform fee. |
| `smallCartThreshold` | The basket size it applies below — say so: *"On orders under ₹200"* |
| `deliveryIsFree` | Delivery waived on this basket |
| `freeDeliveryAbove` | The threshold that waives it |
| `spendMoreForFreeDelivery` | Rupees short of it, `0` when already there |

`spendMoreForFreeDelivery` is the one that earns its place — *"Add ₹351 more
for free delivery"* turns a fee into a reason to add something rather than a
reason to abandon.

It is a **surcharge, not a hard minimum**: the order is never refused for
being small. An empty cart is never surcharged.

### 1.4 Say why a coupon was refused (full rules in §5)

The cart used to print *"Invalid or unavailable coupon code"* for a perfectly
valid code the basket was ₹2 short of, and *"'X' applied · You saved ₹0"* when
the bill had in fact refused it.

`data.pricing` now carries:

| Field | Meaning |
|---|---|
| `couponRejectedReason` | Why it was not applied, in words for the customer |
| `couponNextSlab` | `{ minOrderValue, spendMore, discount }` — the rung above (§1.5) |

Show `couponRejectedReason` verbatim. The server produces sentences a customer
can act on: *"Needs ₹300 minimum — ₹2 more"*, *"First-time customers only"*,
*"Expired"*.

A coupon code is echoed back in `pricing.couponCode` **whether or not it was
honoured**. Never infer "applied" from its presence — check
`pricing.appliedCoupon` or `discount > 0`.

### 1.5 Spend-slab coupons (full rules in §5.4)

A coupon can now carry several spend rungs — *₹50 off above ₹300, ₹120 above
₹600, 25% above ₹1000*. **Admin-only**; a store cannot create one.

Nothing to build for the basic case: the discount arrives in
`pricing.discount` as always. The customer gets the **best rung they have
reached**.

The rung above is worth surfacing:

```dart
final next = pricing['couponNextSlab'];
if (next != null) {
  // "You saved ₹50 · add ₹153 more to save ₹120"
}
```

### 1.6 Substitutions need the customer's consent

Sent at checkout on `POST /food/orders`:

```jsonc
"substitutionPreference": "refund"   // "refund" (default) | "allow"
```

A toggle in the cart. **Defaults to `refund`** — swapping spends the
customer's money on something they did not choose, and the lactose-free
shopper handed ordinary milk has been sold the one thing they were avoiding.
The seller is refused at the API if they try to swap without `allow`.

### 1.7 New socket event: `order_fulfilment_changed`

The basket changed at the shelf. **Its own event, not a status update** — the
order's status has not changed, the bill has.

```jsonc
{
  "orderMongoId": "...", "orderId": "FOD-7441949850",
  "status": "partial",            // partial | substituted
  "shortfallAmount": 313,          // off the ORIGINAL bill, cumulative
  "total": 184.6,
  "refundDue": 313,                // prepaid: already refunded
  "amountDue": 0,                  // COD: what the rider now collects
  "items": [
    { "name": "Chocolate Brownie", "ordered": 4, "arriving": 1, "substitutedFor": "" }
  ],
  "note": "Only 2 on the shelf"
}
```

Show it loudly. A basket that silently arrives smaller and cheaper reads as a
mistake, or as theft, depending which way the customer notices first.

### 1.8 Groceries are not restaurants

Sellers now carry `storeType`: `"grocery"` (**default**) or `"restaurant"`.

When it is `grocery`, **hide the cutlery toggle** and call the note a
*delivery note*, not *cooking requests*. `foodType` and `preparationTime` on a
product mean nothing for a shop either.

---

## 2. Rider app

### 2.1 A rider carries a batch, not a single order

One order per rider was the rule, and it is the most expensive line in a
quick-commerce order: two customers half a street apart served by two separate
trips from the same store.

A second order is allowed **only when it genuinely rides along**:

- **same store** — a second pickup elsewhere is two trips wearing one rider
- **not yet collected** — one pickup serves the whole batch
- **drops close together** — within `BATCH_DROP_RADIUS_KM` (default 1.5 km)

Cap: `MAX_ORDERS_PER_RIDER`, default **3**.

`GET /food/delivery/orders/available` now also returns batchable offers while
the rider is carrying work. Once they collect, the list collapses back to
their own orders — the batch is closed.

### 2.2 Refusals now name the rule

`PATCH /food/delivery/orders/:id/accept` refuses with something actionable
instead of *"You already have an active delivery"*:

| Message | Cause |
|---|---|
| *That is a priority order — it has to be delivered on its own.* | Customer paid for Quick |
| *You are carrying a priority order. Deliver it before taking another.* | Already carrying a Quick order |
| *This order is from a different store. Finish your current pickup first.* | Different seller |
| *You have already collected your current order…* | Past pickup |
| *That drop is too far from the one you are already carrying.* | Outside the radius |
| *You are already carrying N orders…* | At the cap |
| *This would put you at Rs.X in cash, over your Rs.Y limit…* | §2.3 |

Show the message. Do not map these to a generic error.

### 2.3 The cash ceiling counts the whole batch

`cashInHand` is money **already collected**. That was enough at one order
each; with batching, three ₹2,000 COD orders against an empty wallet and a
₹3,000 ceiling ends with the rider holding ₹6,000. Cash the rider has already
promised to collect now counts toward the limit.

### 2.4 The pickup list shows what is actually going

Per §0 — `item.quantity` is the delivered figure. A line the shop could not
supply is **absent from the list**. Collect what the list says.

---

## 3. Seller app

### 3.1 Short picks and substitutions

Groceries go short, and the only expressible answers were *deliver everything*
or *cancel the lot*. Neither is what happens at a shelf.

```
PATCH /food/restaurant/orders/:orderId/fulfilment
```

```jsonc
{
  "lines": [
    { "itemId": "...", "fulfilledQuantity": 2 },                     // short pick
    { "itemId": "...", "substituteItemId": "...", "quantity": 1 }    // swap
  ],
  "note": "Only 2 on the shelf"
}
```

**Send only the exceptions.** A line not mentioned is assumed found in full,
so the common case is one row, not a confirmation of the whole basket.

Response:

```jsonc
{
  "fulfillment": { "status": "partial", "originalTotal": 497.6, "shortfallAmount": 313 },
  "pricing": { ... },
  "refund": { "status": "processed", "amount": 313, "method": "wallet" },
  "refundDue": 313,
  "amountDue": 0
}
```

What happens behind it, so the UI can explain it:

- Units not delivered go **back on the shelf**, to the batches they came from
- The bill is recomputed — **fees are untouched**, the rider still rode
- A coupon is **scaled, not re-evaluated**: telling someone who lost an item
  that they also lost their ₹50 off is worse than the shortfall
- Prepaid is **actually refunded** (wallet or gateway). `payment.status` stays
  `paid` — only part came back
- COD simply collects less
- The customer is told (§1.7)

Refused when: the rider has already collected (*that is a return, not a short
pick*), nothing would be left to deliver (*cancel the order instead*), or the
customer asked for a refund rather than a substitute.

```
GET /food/restaurant/foods/:itemId/substitutes
```

Returns what the product itself nominates, with `inStock` on each. **A
category is not a good enough guess to spend a customer's money on**, so only
nominated replacements are offered — and the API refuses anything else.

### 3.2 Show the customer's substitution choice before offering a swap

`order.substitutionPreference` is `refund` or `allow`. When it is `refund`,
say so on the row instead of letting the picker choose a replacement and only
then be refused.

### 3.3 Own fleet: unchanged

Everything in the 12 Sep handoff §3 still holds, including the sharp edge:
**a seller with a linked rider gets no automatic dispatch.**

---

## 4. Admin

### 4.1 On-time performance

`GET /food/admin/dashboard-analytics` → `data.promise`:

```jsonc
{
  "scored": 3, "onTime": 2, "late": 1,
  "pending": 1, "notApplicable": 67,
  "onTimePercent": 66.67,
  "avgQuotedMinutes": 6,
  "avgVarianceMinutes": -3.27,   // negative is early
  "worstLateMinutes": 2
}
```

Scored against the minutes the customer **actually saw**, not a figure
recomputed today. Orders carrying no promise are `notApplicable` and stay out
of the denominator — otherwise 67 pre-feature orders drag a perfect record to
1%. `onTimePercent` is `null` when nothing was scored; do not render that as
0%.

### 4.2 Batch-tracked stock and FEFO

Products with `manageMultipleBatch` now hold stock as **batches**: an intake,
its expiry, what it cost, what is left.

| Endpoint | Purpose |
|---|---|
| `POST /food/admin/stocks/batches` | Receive an intake |
| `GET /food/admin/stocks/:itemId/batches` | What is on hand and when it goes off |
| `GET /food/admin/stocks/batches/expiring?withinDays=7` | Across a shop, soonest first |
| `POST /food/admin/stocks/batches/write-off-expired` | Clear expired stock now |

Receive body: `{ itemId, batchNo, expiryDate, quantity, purchasePrice }`. An
already-expired intake is refused — that is data entry, not a delivery.

**FEFO, not FIFO.** Picking is by soonest expiry, not arrival: a short-dated
delivery can arrive after a long-dated one, and picking by arrival leaves the
short-dated stock to spoil. Proven on a real order — 6 units took 4 from the
batch that arrived *second* (expiring in 3 days) and 2 from the one that
arrived first.

**Expired units are never picked**, whether or not the write-off sweep has
run. The sweep (hourly) is bookkeeping; the guard is at allocation.

`order.items[].batchAllocations` records which intakes each line holds — a
recall or a complaint traces to a carton.

### 4.3 Spend-slab coupons (validation rules in §5.7)

Admin → Coupons → **Discount Mode: Spend slabs**. Each rung is
`{ minOrderValue, discountType, discountValue, maxDiscount }`, sent as
`slabs` with `discountMode: "slab"`.

Refused: an empty ladder, two rungs at the same spend, a percentage rung with
no cap, a flat rung that gives the order away. The form warns when a higher
rung is worth no more than a lower one — customers get the better rung either
way, so such a rung buys nothing.

### 4.4 Fee settings

Three new fields: `smallCartThreshold`, `smallCartFee`, `freeDeliveryAbove`.
All default to `0`, meaning off.

---

## 5. Coupons — the full picture

Coupons touch three surfaces (customer cart, seller POS, admin), so they are
gathered here rather than scattered. §1.4 and §1.5 are the short version for
the customer app; this is the whole contract.

### 5.1 One judge, three callers

Eligibility lives in **one** place — `evaluateCoupon`. The pricing engine that
decides what an order is actually charged, the cart's coupon list, and the POS
coupon list all call it. A second implementation would drift within a release,
and the drift shows up as a list saying **Apply** over a quote that then
refuses.

**Never re-implement these rules in Dart.** Do not decide client-side whether a
coupon applies, and do not compute the discount to show a preview — call
`calculate` and render what comes back. Every rule below can change from the
admin panel without an app release.

### 5.2 What the pricing response says about a coupon

`POST /food/orders/calculate` → `data.pricing`:

| Field | Type | Meaning |
|---|---|---|
| `couponCode` | string \| null | The code that was **attempted**. Present whether or not it was honoured. |
| `appliedCoupon` | `{ code, discount }` \| null | Non-null **only** when it was actually applied. |
| `discount` | number | Rupees off. `0` when refused. |
| `couponRejectedReason` | string | Why it was refused, in words for the customer. `""` when applied. |
| `couponNextSlab` | `{ minOrderValue, spendMore, discount }` \| null | The rung above, on an **applied** coupon (§5.4). |

**The trap:** `couponCode` is echoed back on refusal too. The web cart used to
read it as success and printed *"'SAVE50' applied · You saved ₹0"* on a bill
that had refused the coupon outright.

```dart
final applied = pricing['appliedCoupon'] != null;   // the only correct test
final reason  = pricing['couponRejectedReason'] as String? ?? '';

if (applied) {
  showSavings(pricing['discount']);
} else if (reason.isNotEmpty) {
  showCouponError(reason);   // verbatim
}
```

### 5.3 The refusal reasons, verbatim

Show them as they arrive. They are written for a customer to act on, and they
are **ordered by what someone can do about it** — *"add ₹120 more"* is worth
saying before *"this campaign is finished"*, because only one of them ends in
a sale.

| Reason | When |
|---|---|
| `No such coupon` | Code does not exist |
| `Expired` | Past the end date |
| `Starts 20 Sep` | Campaign has not opened yet |
| `Paused by admin` | Temporarily stopped |
| `Not active` | Draft or ended |
| `Hidden by admin` | Not offered in the cart |
| `Not for this store` | Scoped to other stores |
| `Needs ₹300 minimum — ₹2 more` | Basket below the entry threshold |
| `Fully used up` | Campaign-wide usage limit reached |
| `This customer has used it` | Per-customer limit reached |
| `First-time customers only` | Customer has ordered before |
| `Pick a customer to use this` | **POS only** — see §5.6 |
| `Works out to no discount on this bill` | Rules pass but the maths gives ₹0 |

Two deliberate details, in case they look like bugs:

- **Dates are judged before status.** An expired campaign is also flipped
  inactive by the monthly sweep, and *"Not active"* tells a cashier nothing
  they can repeat to a customer — *"Expired"* does.
- **An end date saved as midnight means "through that day"**, not "until the
  moment it began". Taken literally it expires a coupon a day early, which is
  exactly the sort of thing a customer notices at a counter.

### 5.4 Spend slabs

A coupon can carry several spend rungs — *₹50 off above ₹300, ₹120 above ₹600,
25% above ₹1000*. **Admin-only**: a store attempting one is refused with
*"Spend-slab coupons are set up by the admin. Please ask them to create it."*

On the offer document:

```jsonc
{
  "discountMode": "slab",            // "single" (default) | "slab"
  "slabs": [
    { "minOrderValue": 300,  "discountType": "flat-price", "discountValue": 50,  "maxDiscount": null },
    { "minOrderValue": 600,  "discountType": "flat-price", "discountValue": 120, "maxDiscount": null },
    { "minOrderValue": 1000, "discountType": "percentage", "discountValue": 25,  "maxDiscount": 300 }
  ]
}
```

Rules the apps should know:

- **The customer gets the best rung they have reached**, not simply the
  highest one below their basket. Those are the same for a sanely configured
  campaign and differ only when someone builds a higher rung that pays less —
  a misconfiguration the customer should not be charged for.
- **The entry threshold is the bottom rung.** `Needs ₹300 minimum` on a slab
  coupon means the cheapest rung, not the best one.
- Rungs are **sorted on read as well as on write**, so a document saved before
  that existed, or edited straight in the database, cannot change what a
  customer is charged.

`couponNextSlab` is what makes a ladder worth building — nobody climbs a rung
they were not told about:

```dart
final next = pricing['couponNextSlab'];
if (next != null) {
  // "You saved ₹50 · add ₹153 more to save ₹120"
  final line = 'Add ₹${next['spendMore']} more to save ₹${next['discount']}';
}
```

It is `null` when the coupon has no slabs, the customer is on the top rung, or
climbing would not actually pay better. `discount` is what the rung is worth
**at its own threshold** — a percentage rung pays more on a bigger basket, and
quoting that larger figure would promise a saving the customer would not get
by spending exactly the minimum.

### 5.5 The customer-facing coupon list — a known gap

`GET /food/restaurant/offers` (query: `restaurantId`, `subtotal`, `userId`)
still returns the **single-mode shape only**: `title`, `discountType`,
`discountValue`, `maxDiscount`, `minOrderValue`. It does **not** carry
`discountMode` or `slabs`.

In slab mode the top-level fields are **mirrored from the bottom rung**, so a
three-rung ladder lists as *"Flat ₹50 OFF"* above ₹300. That is honest but
incomplete — the ₹120 and 25% rungs are invisible until the basket grows and
`couponNextSlab` appears in the cart.

**Do not compute a slab preview from this endpoint** — the data is not there.
Either list it as the bottom rung (matching today's web behaviour) or wait for
the endpoint to carry slabs. Flagged in §8.

### 5.6 Coupons at the POS

`POST /food/restaurant/pos/coupons` judges a whole list at once: the customer's
facts are resolved once and reused, so twenty coupons cost the same two
queries as one. Each entry comes back with its verdict and a
cashier-readable description:

- `describeCoupon` renders *"20% off, up to ₹100"* for single mode, and
  rung-by-rung for a ladder: *"₹50 off above ₹300, ₹120 off above ₹600"*.
- **`Pick a customer to use this`** — an anonymous walk-in cannot be tested
  against a per-customer rule (`perUserLimit`, first-time-only). The pricing
  engine will refuse it for the same reason, so the list says so up front
  rather than offering it and letting the sale bounce.

### 5.7 What admin may and may not configure

Admin → Coupons → **Discount Mode**. Rejected at the API, with the message
shown in the form:

| Refused | Message |
|---|---|
| Slab mode with no rungs | *A slab coupon needs at least one slab* |
| Two rungs at the same spend | *Two slabs both start at ₹300 — give each one its own spend* |
| A percentage rung with no cap | *The ₹1000 slab is a percentage, so it needs a maximum discount* |
| A flat rung ≥ its own threshold | *₹300 off a ₹300 spend gives the order away — lower the discount* |

The form also **warns without blocking** when a higher rung is worth no more
than a lower one: customers get the better rung either way, so such a rung
buys nothing — but it is a campaign choice, not an error.

### 5.8 A coupon survives a short pick

When a basket goes short at the shelf (§3.1) the coupon is **scaled, not
re-evaluated**. A customer who has already lost an item should not also be
told they lost their ₹50 off because the smaller basket no longer clears the
threshold. Two punishments for one shortage is how a refund becomes a
complaint.

`discount` on the adjusted order therefore may not equal what the coupon's
current rules would produce on the new subtotal. That is intentional; do not
"correct" it client-side.

---

## 6. Configuration added today

| Env | Default | What it controls |
|---|---|---|
| `MAX_ORDERS_PER_RIDER` | 3 | Batch cap |
| `BATCH_DROP_RADIUS_KM` | 1.5 | How far apart two drops may be |
| `PER_DROP_MINUTES` | 4 | What one doorstep ahead costs the next customer |
| `UNDISPATCHED_ORDER_TIMEOUT_MINUTES` | 120 | When an order no rider took is given up on |

---

## 7. Bugs fixed today that change observed behaviour

Worth knowing because the apps may have been built around them:

1. **A second short pick refunded the first one again.** ₹400 → ₹300 → ₹200
   owes ₹200 and paid out ₹300. `shortfallAmount` is cumulative against
   `originalTotal`; only the difference now moves.
2. **Cancelling a short-picked order invented stock.** Four taken, two
   returned at the shelf, four returned again on cancellation.
3. **A substitution leaked units out of their batch** — count and batches
   drifted further apart with every swap.
4. **FEFO handed out expired stock preferentially** — an expired batch has the
   soonest expiry of all, so it was picked first.
5. **The seller was charged commission on goods they never sold**, and the
   settlement ledger kept the pre-short-pick figures.
6. **Orders no rider ever took were never closed** — they sat confirmed for
   ever holding reserved stock. 19 had accumulated in one database, locking up
   11 units of one product.
7. **Auto-cancelled orders sat `promise: pending` for ever**, growing the
   report's denominator.

---

## 8. Open decisions

Product calls, not defects — flagging so they are chosen rather than
discovered:

1. **A quick order cannot be batched at all.** Correct for what the customer
   paid for, but it lowers rider utilisation. Worth watching once §4.1 has
   data.
2. **Substitution is seller-proposed, customer-preauthorised.** There is no
   "approve this swap within 60 seconds" round trip. If you want one, the
   preference flag is where it would hang.
3. **Small-cart fee vs a hard minimum.** Currently a surcharge; the order is
   never refused for being small.
4. **`spendMoreForFreeDelivery` is not shown on the storefront**, only in the
   cart. It is arguably more persuasive while browsing.
5. **The coupon-list endpoint does not carry slabs** (§5.5), so a ladder
   advertises only its bottom rung until the customer is in the cart. Adding
   `discountMode` and `slabs` to `GET /food/restaurant/offers` is a small
   change; whether a list row should show the whole ladder or just the entry
   rung is the actual decision.

## 9. Still missing

Not built, and known:

- **Purchase orders / GRN.** `POST /stocks/batches` is the receiving half;
  there is no supplier, no PO, no receiving *against* one.
- **Live ops console.** No screen shows orders breaching promise, idle vs busy
  riders, ageing unassigned orders or current stockouts. §4.1 is the report,
  not the control room.
