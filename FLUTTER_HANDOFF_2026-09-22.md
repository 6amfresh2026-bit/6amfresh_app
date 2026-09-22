# Flutter Handoff — 22 Sep 2026

Everything built in this session that a Flutter app has to care about, and the
things that look like they concern you but do not.

Base URL: `{API_BASE}/api/v1` — e.g. `http://localhost:5000/api/v1` in dev.

Read the **Rider app** section first. It contains the only change that will
break an existing build if you ignore it.

---

## 0. TL;DR — what actually changes for each app

| App | Change | Breaks existing build? |
|---|---|---|
| **Rider** | Availability is no longer a boolean — 5 new pause modes | **Yes, silently.** See §1 |
| **Rider** | New socket event `order_unassigned` + matching push | No, but the rider keeps a dead order on screen without it |
| **Rider** | A location ping no longer knocks the rider offline (bug fix) | No — it fixes a live bug |
| **Rider** | Zone auto-online toggle | No, opt-in |
| **Customer** | Brand colour is now teal `#47B8AE`; new logo assets | Cosmetic |
| **Customer** | Low-stock info is **not** on customer endpoints yet — see §3.4 | No |
| **Seller** | Low-stock screen now returns tiers, and returns far more rows | Shape changed, see §3.3 |
| **Seller** | Products accept 3 stock thresholds instead of 1 | Additive |

---

## 1. Rider app — availability modes (**important**)

### What changed

`availabilityStatus` used to be `'online' | 'offline'`. It now has five more
values, all of which mean "on shift but not accepting new orders":

```
online          // the only state dispatch will offer an order to
offline         // gone home
on_break
washroom
emergency
vehicle_issue
cannot_collect
```

### Why this can break you silently

The endpoint coerces anything it does not recognise to `offline`. So if the
rider app sends `"break"` or `"paused"` or any other spelling, the rider goes
**offline** and nobody sees an error. Send exactly the strings above.

### Endpoint

```
PATCH /food/delivery/availability
Authorization: Bearer <delivery partner token>
```

```json
{ "status": "on_break", "latitude": 17.385, "longitude": 78.4867 }
```

`latitude`/`longitude` are optional but send them when you have them — they
update the rider's last known position, which the admin reassignment screen
uses to sort riders by distance.

Response:

```json
{ "success": true, "data": { "availabilityStatus": "on_break" } }
```

Legacy `true` / `false` / `"true"` / `"false"` are still accepted for the plain
online toggle, so an old build keeps working.

### One rule that still applies

A rider linked into a **seller's own fleet** can only go `online` from inside
that seller's delivery zone. Going online elsewhere returns:

```
400  "You can only go online while inside your seller's delivery zone"
```

This check applies to `online` **only** — a rider can go `on_break` or
`offline` from anywhere. Do not block the pause buttons on location.

### UI the spec asked for

A large ONLINE 🟢 / OFFLINE ⚫ control, plus a secondary picker for the five
pause modes. The pause modes are deliberately distinct from `offline`: a rider
in the washroom for two minutes and one who has gone home both stop receiving
orders, but only one of them is a staffing problem, and ops cannot tell them
apart if both say "offline".

**Not built on web.** The web rider app still shows the old boolean toggle. The
API and the admin-side display are done. You are not duplicating existing work
here.

---

## 2. Rider app — an order can now be taken off you

### Socket

Room: the rider's own room (unchanged).

| Event | Payload | Meaning |
|---|---|---|
| `order_assigned` | full delivery order payload | You have a new order (existing) |
| `order_unassigned` | `{ "orderId": "<mongo id>" }` | **New.** This order is no longer yours |

### Push

An accompanying push arrives with `data.type = "order_unassigned"` and
`data.orderId`.

### What the app must do

Remove the order from the active list immediately. Before this existed, an
admin could move an order to another rider and the first rider's screen still
showed it — they would arrive at the shop for an order somebody else was
already carrying.

### When it happens

Admin moves a live order to a different rider (rider went on break, vehicle
broke down, cannot collect, etc.). The order must be **pre-pickup** — the API
refuses to reassign once `deliveryState.pickedUpAt` is set, because handing the
order to somebody else does not hand them the bag.

### Related behaviour change worth knowing

The stuck-order watchdog used to release **any** order sitting in `assigned`
for two minutes without being accepted, and re-race it to the pool. It no
longer does that for orders a person assigned by hand
(`dispatch.assignmentMode === 'manual'`). An auto-assignment nobody accepted
still heals as before.

For the rider app this means: a manually assigned order will **not** silently
disappear after two minutes any more. It stays yours until you accept or an
admin moves it.

---

## 2b. Rider app — location pings, and zone auto-online

### The bug you were probably working around

A `PATCH /food/delivery/availability` call carrying **only** coordinates used
to come back `offline`. An absent `status` fell through the normaliser and was
read as offline, so every plain location ping ended the rider's shift.

That is fixed. A payload with no `status` field is now treated as a location
update and the rider's current status is left alone.

**Send location-only pings without a `status` field:**

```json
{ "latitude": 17.385, "longitude": 78.4867 }
```

If you send `status` on every ping — as the web app did — you are re-asserting
the status each time. That still works, but it disables zone auto-online (see
below), because an explicit status always wins.

### Zone auto-online (the dark-store toggle)

When a rider has `autoOnlineInZone: true`, a **location-only** ping from inside
an active zone puts them online automatically.

```json
// response
{ "availabilityStatus": "online", "autoOnlined": true }
```

`autoOnlined` tells you the server changed the status by itself, so the app can
update its toggle and tell the rider why they just went online.

**What it will never do**, and you can rely on this:

| Situation | Result |
|---|---|
| Toggle off | Nothing. Off by default. |
| Rider is `on_break` / `washroom` / `emergency` / `vehicle_issue` / `cannot_collect` | Stays exactly as-is. A pause is deliberate; not having moved is not consent to take orders again. |
| Explicit `status: "offline"` sent from inside the zone | Stays offline. Otherwise the offline button would flip straight back on and be unusable. |
| Outside any active zone | Nothing. |

Only `offline` → `online` is ever automatic.

The toggle itself is set by admin today
(`PATCH /food/admin/delivery/:id` with `{ "autoOnlineInZone": true }`) and is
returned on the rider rows in the admin list. If the rider app should own this
switch too, say so and a rider-side endpoint will be added.

---

## 3. Low stock

### 3.1 The tiers

Five states, resolved per product:

```
untracked   // stockQty is null — nobody counts this item
in_stock
low
critical
out
```

`untracked` is **not** "out of stock". Never render an out-of-stock badge for
it — the product is perfectly available, it just is not counted.

### 3.2 Where the thresholds come from

Resolved in this order, per field:

1. the product's own `lowStockThreshold` / `criticalStockThreshold` /
   `outOfStockThreshold`
2. the outlet's `stockThresholds: { low, critical, out }`
3. platform defaults `{ low: 10, critical: 3, out: 0 }`

Each tier is "at or below". `out` is configurable rather than fixed at zero
because a shop that must never promise its last unit sets it to `1`.

You do **not** need to implement this resolution. The server sends you the
answer (§3.3).

### 3.3 `stockBadge` — the object to render

Returned on product rows from:

- `GET /food/admin/foods` (admin)
- `GET /food/restaurant/foods/low-stock` (seller)

```json
{
  "tier": "critical",
  "label": "Critical stock",
  "remaining": 3,
  "needsAttention": true,
  "thresholds": { "low": 10, "critical": 3, "out": 0 }
}
```

Render it when `needsAttention` is true. Show the **number**, not just the
word — "Low stock" alone tells a buyer nothing about whether to hurry and a
shop nothing about what to reorder:

```
⚠️ Low stock · 5 left
⚠️ Critical stock · 3 left
⚠️ Out of stock
```

Suggested colours: low = amber, critical = orange, out = red.

**Seller low-stock list changed shape and size.** It used to return only
products that carried their own `lowStockThreshold`, which meant a shop that
configured thresholds once on the outlet saw an empty screen. It now returns
every stock-tracked product that needs attention, each with a `stockBadge`,
worst first. Expect many more rows than before.

### 3.4 Customer app — read this before you build the card

**The customer-facing product endpoints do not return `stockBadge` yet.** Only
the admin and seller endpoints do.

If the customer app needs "⚠️ Low Stock · 3 remaining" on a product card, say
so and the same `stockBadge` object will be added to the storefront
serializers. Do not compute the tier client-side from `stockQty` — the
thresholds are per-outlet and per-product and the client does not have them, so
anything you calculate locally will disagree with what the shop sees.

### 3.5 Notifications

A push goes to the **seller** when a product crosses down into a worse tier:

```json
{
  "type": "stock_alert",
  "tier": "low",
  "itemId": "<mongo id>",
  "remaining": "5"
}
```

Title: `"Low stock: Amul Gold Milk 1L"`, body: `"Amul Gold Milk 1L — 5 left."`

It fires on the **crossing**, not on the state, so a shop selling forty units
of a low item across a morning gets one notice and not forty. Restocking back
up is deliberately silent.

### 3.6 Setting thresholds

Products (admin and seller product create/update) accept:

```json
{
  "lowStockThreshold": 8,
  "criticalStockThreshold": 2,
  "outOfStockThreshold": 0
}
```

All three optional. Send `null` or omit to inherit the outlet's defaults, which
is the intended common case — nobody fills in three numbers on four thousand
SKUs.

Outlet defaults (admin only today):

```
PATCH /food/admin/restaurants/:id
{ "stockThresholds": { "low": 20, "critical": 5, "out": 1 } }
```

Fields are individually optional; sending only `low` will not wipe the other
two. The server clamps so the tiers cannot cross — a `critical` above `low`
comes back equal to `low`.

---

## 4. Admin-only — no Flutter work

Listed so you can skip them with confidence.

- **Delivery History** — `GET /food/admin/delivery/history`. Who carried which
  goods to whom and when, including cancelled and returned-to-store runs.
- **Delivery reassignment panel** — `GET /food/admin/orders/:id/assignable-riders`
  and `POST /food/admin/orders/:id/reassign-delivery`. The rider-facing half of
  this is §2.
- **Deliveryman list filters** — availability, zone, vehicle, fleet, and
  whether the rider can actually receive a push.
- **Point of Sale** was removed from the admin panel. Unrelated to the seller
  app's own POS, which is untouched.

---

## 5. Brand

| Asset | File | Use |
|---|---|---|
| Wordmark | `Frontend/src/modules/Food/assets/6am-fresh-brand.png` | Wide slots: nav bars, headers, splash |
| Icon (leaf) | `Frontend/src/modules/Food/assets/6am-fresh-icon.png` | Square slots: app icon, small tiles, notification icon |

Do not scale the wordmark into a square slot — it is 2.7:1 and gets cropped or
squashed. Use the icon there.

### Theme colour

The customer app's brand colour is now **teal `#47B8AE`** (was pink
`#FA0272`). Seller stays blue `#2563EB`, rider stays green `#00B761`.

**The colour is configuration, not code.** It lives in the database and is
served by:

```
GET /food/admin/business-settings/public
```

```json
{
  "powerScanning": {
    "user":       { "themeColor": "#47B8AE", "fontFamily": "Poppins" },
    "restaurant": { "themeColor": "#2563EB", "fontFamily": "Poppins" },
    "delivery":   { "themeColor": "#00B761", "fontFamily": "Poppins" }
  }
}
```

Read your module's `themeColor` at startup and build the `ThemeData` from it
rather than hardcoding the hex. A hardcoded hex is exactly why the web apps
shipped in two different brands at once, and why changing the colour in admin
appeared not to work.

---

## 6. Still open — do not build against these yet

1. **Single vendor → multiple outlets.** Not implemented. One phone still maps
   to one outlet, and seller login uses `findOne`, so if two outlets share an
   `ownerPhone` today the second one cannot be logged into at all. Waiting on a
   decision: keep `ownerPhone` as the vendor key, or introduce a real `Vendor`
   entity. An outlet switcher in the seller app depends on this.

2. **Customer-facing `stockBadge`** — §3.4.

---

## 7. Local testing

```
Backend   http://localhost:5000
Frontend  http://localhost:5173
Mongo     :27018   Redis :6380   (docker compose up -d)
```

Dev auth: `USE_DEFAULT_OTP=true`, OTP `1234`.

| Role | Login |
|---|---|
| Admin | `admin@6am.com` / `password123` |
| Seller | phone `9999900001`, OTP `1234` |
| Rider | phone `9800000001`, OTP `1234` |

Rider OTP flow: `POST /food/auth/delivery/request-otp` then
`POST /food/auth/delivery/verify-otp`. The token is at
`data.accessToken`.

Quick check that availability modes are live:

```bash
curl -X PATCH http://localhost:5000/api/v1/food/delivery/availability \
  -H "Authorization: Bearer $RIDER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"vehicle_issue"}'
```

Expect `{"availabilityStatus":"vehicle_issue"}`. If you get `"offline"` back,
the string you sent was not recognised.
