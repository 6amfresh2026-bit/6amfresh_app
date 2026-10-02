# Flutter Handoff — 2 Oct 2026

Everything that changed since `FLUTTER_HANDOFF_2026-09-22.md` that a Flutter app
has to care about, and the things that look relevant but are not.

Base URL: `{API_BASE}/api/v1` — e.g. `http://localhost:5000/api/v1` in dev.
Envelope everywhere: `{ "success": true, "message": "…", "data": … }`.

Verified against a live backend with real customer / seller / rider accounts
(not just unit tests). Test OTP in dev is `1234` for every role.

---

## 0. TL;DR

| App | Change | Breaks existing build? |
|---|---|---|
| **Rider** | A second, nearby order from a *different* seller can be assigned to you mid-trip, with no accept step | **Yes if you assume one order.** See §1 and `FLUTTER_BLOCK_BATCHING_FLOW.md` |
| **Rider** | `GET /orders/current` now returns the *oldest-accepted* order, plus `batchOrders` | Same as above |
| **Rider** | `pricing.roadDistanceKm` / `distanceKm` / `deliveryMode` now present on every rider order response (they were silently missing) | No — fixes a wrong-distance bug. See §2 |
| **Customer** | Zoned restaurant listings now include restaurants that have no zone | Behaviour change, see `FLUTTER_ZONE_FLOW.md` |
| **Seller** | `GET /restaurant/current` now returns `zoneId` and `storeType` (were always `""` / `"grocery"`) | No, but fixes onboarding logic. See §3 |
| **Seller** | Percentage coupons require `maxDiscount` | A create call without it is rejected (it always was; the message is now explained). See §4 |
| **All** | Maps key rotated. Read it from public settings, not a hard-coded constant | See §5 |

Related docs: `FLUTTER_BLOCK_BATCHING_FLOW.md`, `FLUTTER_ZONE_FLOW.md`,
`DELIVERY_API_SPEC.md` (updated for `orders/current` and socket events).

---

## 1. Rider app — block batching (read this first)

One feature, full detail in `FLUTTER_BLOCK_BATCHING_FLOW.md`. The parts that
affect code:

1. **A rider can now carry two active orders.** If you hold one `activeOrder`
   in state and overwrite it from every response, you will lose the first one.
2. `GET /food/delivery/orders/current` →
   ```json
   { "activeOrder": {
       "_id": "…", "order_id": "FOD-3058134669", "orderStatus": "preparing",
       "…": "full order, as before",
       "batchOrders": [
         { "_id": "…", "order_id": "FOD-5202958659", "orderStatus": "preparing",
           "restaurantName": "Block Batch Test Store", "pricing": { "total": 157.6 } }
       ]
   } }
   ```
   `activeOrder` is the order the rider accepted **first**. `batchOrders` is
   absent when there is nothing else. It is a *summary* — fetch
   `GET /orders/:orderId` for the rest.
3. **New socket event `order_added_to_batch`** (+ an FCM push with
   `data.type = "order_added_to_batch"`). It is informational. **Do not** show
   the "swipe to accept, 45 seconds" modal for it — the order is already the
   rider's (`dispatch.status` is `accepted`).
4. **`order_deassigned` can fire for an order you never showed an accept prompt
   for.** Two nearby orders can race for the same rider; the loser is released.
   Drop it quietly. Its `reason` text ("Not accepted in time") is wrong for this
   case — do not show it to the rider.
5. Work the orders oldest-first. When the first is delivered, the next
   `GET /orders/current` returns the second as `activeOrder` on its own.

What is **not** needed: a UI that lets the rider switch between two "at pickup"
flows. Show a banner for the batched order and let the hand-off be automatic.

---

## 2. Rider app — distance on the offer card

### The bug that was fixed

`GET /food/delivery/orders/available`, `/orders/current` and `/orders/:id`
replaced the order's `pricing` with the transaction's snapshot, which only holds
money lines. So `pricing.roadDistanceKm`, `pricing.distanceKm` and
`pricing.deliveryMode` were **missing** from every one of those responses.

Anything that fell back to computing a straight-line distance showed a shorter
number than the customer was quoted — 9.6 km on screen for a 13.1 km order.

### What you get now

```json
"pricing": {
  "subtotal": 99, "deliveryFee": 20, "platformFee": 5, "total": 157.6,
  "roadDistanceKm": 13.09,
  "distanceKm": 13.09,
  "deliveryMode": "basic"
}
```
Money fields still come from the transaction; the rest from the order.

### Rule for the app

For "Restaurant → Customer" use, in this order:

1. `tripDistanceKm` (socket payload, set when the route is cached)
2. `pricing.roadDistanceKm`
3. only then a client-side Directions call
4. straight-line **last**, and label it as approximate

Never let straight-line win just because the Maps SDK has not finished loading;
that is exactly how the wrong number reached a rider. `roadDurationMins` is
still `null` on the order, so compute ETA from the distance or call the route
endpoint.

### Route endpoint (unchanged, now confirmed)

```
GET /food/delivery/orders/:orderId/route?lat=&lng=&target=restaurant|customer
→ { polyline, distanceMeters, distanceKm, durationSeconds, durationMins, target, origin, destination }
```
Each call is a billed Directions request. Call it when a trip phase starts, not
on a timer. `polyline: ""` with HTTP 200 means Directions could not route —
draw markers only, do not treat it as an error.

---

## 3. Seller app — profile now returns `zoneId` and `storeType`

`GET /food/restaurant/current`, the accepting-orders toggle response and the
profile update response previously dropped two fields:

| Field | Before | Now |
|---|---|---|
| `zoneId` | always `""` | the real id (string), `""` only if the store has none |
| `storeType` | always `"grocery"` (the default) | the stored value |

If your onboarding checklist keys off `zoneId`, "Set your delivery zone" will
now complete correctly. Two more things the same checklist got wrong, so you do
not copy them:

- The seller menu is `GET /food/restaurant/menu` →
  `data.menu.sections[].items[]` (and `categories`). It is **not** a flat
  `items` array and has no `total`. Count items by walking `sections`.
- The profile has no top-level `address`. The address is inside `location`
  (`formattedAddress`, `addressLine1`, …). Read it from there.

Bank details are complete when both `accountNumber` and `ifscCode` are non-empty;
the outlet profile is complete with an address **and** `fssaiNumber`.

---

## 4. Seller app — coupons

```
POST   /food/restaurant/my-offers
GET    /food/restaurant/my-offers          → data: { offers: [...] }
PATCH  /food/restaurant/my-offers/:id/status   { "status": "active" | "paused" }
DELETE /food/restaurant/my-offers/:id
```

Create body:

```json
{
  "couponCode": "SAVE10",
  "discountType": "percentage",
  "discountValue": 10,
  "minOrderValue": 100,
  "maxDiscount": 50,
  "usageLimit": 200,
  "perUserLimit": 1,
  "startDate": "2026-10-02",
  "endDate": "2026-12-31",
  "isMonthly": false,
  "status": "active"
}
```

Rules to enforce in the form, because the server will reject otherwise:

- `discountType: "percentage"` **requires** `maxDiscount > 0`. Do not label that
  field optional or "No cap". (A flat discount ignores it.)
- `discountValue` ≤ 100 for percentage.
- `startDate` not in the past; `endDate` required unless `isMonthly` is true.
- Server error for a missing cap is `maxDiscount is required for percentage
  coupons` — map it to something a seller can read.

`endDate` is stored as 23:59:59.999 **UTC** of the chosen day. In IST that is
the next morning, so a naive local render shows the day after. Render the date
you sent, not a converted timestamp.

---

## 5. Google Maps key

The key lives in the admin's business settings, not in the app:

```
GET /food/admin/business-settings/public  →  data.googleMapsApiKey
```

The web apps read it from there at runtime, which is why rotating it needed no
rebuild. The same key is used server-side for Directions (`Backend/.env`).

For Flutter: the Android/iOS Maps SDK needs the key in native config
(`AndroidManifest.xml`, `AppDelegate`), so it cannot simply follow the API. Two
options — pick one and tell the backend dev:

1. Put the same key in native config and rotate both together, or
2. Use a separate Android/iOS-restricted key for the apps and keep the current
   key for web + server.

Either way, ask for **application restrictions** (Android package + SHA-1, iOS
bundle id) on the app key. A key that works from anywhere will be scraped from
the APK.

APIs confirmed enabled on the current key: Maps JavaScript, Directions,
Geocoding, Places (legacy and new), Distance Matrix.

---

## 6. Things that look relevant but are not

- **Zone deletion now fails with 400** when a seller is still assigned. That is
  an admin-panel action; no Flutter screen calls it.
- **Seller panel redirects, "Getting Started" progress, brand text** — web-only
  fixes.
- **Admin dashboard, order list, live-tracking** — web-only. Live tracking
  needs `VITE_FIREBASE_DATABASE_URL`; without it the web console logs a
  Firebase error. Not an API problem.

---

## 7. Testing notes

- A rider only receives dispatch if `lastLocationAt` is within 45 minutes. After
  a long idle period the order simply finds nobody — that is correct, not a bug.
  Send a location ping first.
- Batching only triggers when **both** sellers have no linked fleet riders, the
  drops are within ~1.5 km of each other, the pickups are within ~1.5 km of each
  other, and nothing on the rider's plate has been picked up yet. Quick/priority
  orders never batch.
- A seller with its own fleet never reaches the shared pool, so a fleet-linked
  rider test account will "never batch". That is by design.

## Gotchas checklist

- [ ] Never hold a single `activeOrder` and overwrite it blindly from `/orders/current`.
- [ ] `order_added_to_batch` is not an offer: no accept modal, no countdown.
- [ ] Quietly handle `order_deassigned` for an order you never surfaced.
- [ ] Use `pricing.roadDistanceKm` for Restaurant → Customer; straight-line last.
- [ ] Percentage coupon form: `maxDiscount` is required, not optional.
- [ ] Count seller menu items from `menu.sections[].items`, read address from `location`.
- [ ] Get the Maps key from public settings (or a restricted app key), never a hard-coded constant.
