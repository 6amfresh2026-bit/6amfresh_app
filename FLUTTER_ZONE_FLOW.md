# Zone flow — Flutter integration guide

_Last verified against backend: 2026-09-30 (commit `cfe2151`)_

This doc explains how "zone" (a service-area polygon an admin draws) works end
to end, and exactly what the app needs to call and handle at each step. It's a
companion to `FLUTTER_API_SPEC.md` — read that for full request/response
shapes on every endpoint; this one is about the *flow* and the gotchas.

## What a zone actually is

A zone is a hand-drawn polygon on a map (minimum 3 lat/lng points), created by
an admin. It answers one question: **is this location inside an area we
service at all?** It is *not* GeoJSON — the backend does its own point-in-polygon
test — and it is a completely separate mechanism from a restaurant's own
delivery radius (more on that below). Both gates have to pass for a restaurant
to be orderable.

## The flow, step by step

### 1. Detect the customer's zone — do this first, before anything else

Right after location permission is granted (and again whenever the device
location changes meaningfully):

```
GET /food/zones/detect?lat=&lng=
```

```json
// in service
{ "success": true, "message": "Zone detected",
  "data": { "status": "IN_SERVICE", "zoneId": "665f...", "zone": { /* full zone doc */ } } }

// out of service
{ "success": true, "message": "Out of service",
  "data": { "status": "OUT_OF_SERVICE", "zoneId": null, "zone": null } }
```

`400` if `lat`/`lng` are missing or not finite numbers.

**Cache this client-side.** The web app caches the result 30s in memory plus
180s server-side (same coords round to the same cache key), and persists the
last known `zoneId`/`zone` to local storage so a momentary GPS/network blip
doesn't flash the "out of service" screen. Do the same in Flutter — don't call
`/zones/detect` on every frame of a location stream; debounce (the web app
debounces 350ms and only re-fires if the device moved more than ~10m).

If `status` is `OUT_OF_SERVICE`, show the out-of-zone screen and stop —
don't bother calling the restaurant listing yet.

### 2. Pass `zoneId` into every listing and search call

Once you have a `zoneId`, thread it through:

- `GET /food/restaurant/restaurants?zoneId=...` (+ your usual `lat`, `lng`, `radiusKm`, `sortBy` params)
- `GET /food/search/unified?q=...&zoneId=...`
- `GET /food/landing/settings/public?zoneId=...`
- category endpoints that take `zoneId`

**What the filter actually does (as of the fix in `cfe2151`):** a restaurant
shows up if *either* it has no zone assigned at all, *or* its zone matches the
one you passed. It's only excluded if it has a zone and that zone is a
*different* one. Most restaurants in this system have no zone assigned — zone
is opt-in per restaurant, set by hand by an admin — so don't assume every
result in a zoned query actually "belongs" to that zone; a good chunk of them
just aren't zone-restricted at all.

Before this fix, the filter was an exact match, which silently hid every
zone-less restaurant from any zoned query. If you're diffing behavior against
an older backend build and restaurants that used to be missing suddenly
appear, that's this fix, not a regression.

### 3. The second, independent gate: delivery radius

Even inside the right zone, a restaurant only shows in a location-aware
listing if the customer's coordinates are within that restaurant's own
`deliveryRadiusKm` (haversine distance from the store's pin). A restaurant
with `deliveryRadiusKm` unset or `0` has **no radius limit** — it's zone-only.
A restaurant with no coordinates set at all is never excluded by distance
(there's nothing to measure from) — it stays listed and judged on zone alone.

So: zone check + radius check, both independent, both applied to every
location-aware restaurant listing. Neither implies the other.

### 4. Checkout — the backend re-verifies, don't trust your own cached zoneId

When the order is placed, the backend does **not** trust the `zoneId` the
client sends. It re-runs the same point-in-polygon test against the actual
`deliveryAddress` on the order, and:

1. If the address isn't inside *any* active zone → `400`, message:
   `"We don't deliver to this address yet"`
2. If it *is* in a zone, but the restaurant has its own zone set and it's a
   *different* one → `400`, message:
   `"This seller does not deliver to the selected address"`
3. Separately, distance from the store to the address is checked against
   `deliveryRadiusKm` again.

Error shape (standard across the API):
```json
{ "success": false, "message": "This seller does not deliver to the selected address", "error": "..." }
```

**Why this matters for the UI:** a customer can select a *different saved
address* at checkout than the one their zone was detected from. If they do,
and that address is outside the restaurant's zone, the order will be rejected
even though the restaurant appeared fine in the listing (listing was checked
against the *device's current location*, not whichever saved address they
pick at checkout). Handle the `400` on order creation gracefully — don't treat
it as a generic failure; show the actual message, since it's already
written for an end user.

### 5. If you're building the delivery partner (rider) app too

Two zone-related rules affect a rider's own online/offline state:

- **Auto-online-in-zone**: if the rider has opted into `autoOnlineInZone` and
  is currently `offline`, a plain location-update ping (not an explicit status
  change) that lands inside *any* active zone flips them to `online`
  automatically. Sending an explicit status in the same request always wins —
  auto-online never overrides an explicit "go offline", and never lifts a
  pause state (break/washroom/emergency/etc).
- **Seller-locked riders**: if the rider is tied to a specific restaurant
  (dark-store/single-seller fleet) and that restaurant has its own zone, the
  rider can only go *online* while their device is physically inside that same
  zone. Otherwise: `400`, `"You can only go online while inside your seller's
  delivery zone"`.

## Quick reference

| Question | Where it's answered |
|---|---|
| Is this address serviced at all? | `GET /food/zones/detect` (client-facing), re-verified server-side at order creation |
| Should this restaurant appear in a listing? | zone match (or restaurant has no zone) **and** within `deliveryRadiusKm` |
| Will this order actually be accepted? | Same zone rule, re-run against the *delivery address on the order*, not the cached device location |
| Can this rider go online right now? | `autoOnlineInZone` (any zone) or seller-lock (specific zone), independent of the customer-facing rules above |

## Gotchas checklist

- [ ] Debounce `/zones/detect` calls — don't fire on every location update.
- [ ] Persist the last known zone locally so a GPS blip doesn't show "out of service" for real customers.
- [ ] A restaurant appearing in a zoned listing does **not** guarantee it has that zone — it may just be zone-unrestricted. Don't display zone info you don't actually have.
- [ ] Handle the checkout-time `400` for zone/radius mismatch as a real, user-facing message — it can legitimately happen even after a clean listing, if the customer changed their delivery address at checkout.
- [ ] Radius and zone are separate gates. A restaurant can fail one and pass the other; both must pass.
