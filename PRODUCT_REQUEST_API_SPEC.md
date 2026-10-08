# Product Request API — Flutter Integration Spec

**Feature:** "Request a New Product" — a logged-in customer asks for a product the
catalog does not carry yet. The request is stored and shown to admins, who triage
it (pending → reviewed / approved / rejected / fulfilled). The customer can see
their own requests and the status/response.

**Audience:** Flutter (customer app) developer.
**Last updated:** 2026-10-08

---

## 1. Basics

| | |
|---|---|
| Base URL | `https://<API_HOST>/api/v1` (same host the app already uses) |
| Auth | **Bearer USER access token** (the same token used for cart/orders) |
| Content-Type | `application/json` |
| Module | `food/user` (customer endpoints) |

All endpoints below require the customer to be **logged in**. Send the header:

```
Authorization: Bearer <USER_ACCESS_TOKEN>
```

> The access token is the one you already get from the OTP login flow
> (`POST /food/auth/user/verify-otp` → `data.accessToken`). No new login is needed.

**Standard response envelope** (same as the rest of the app):

```json
{ "success": true, "message": "…", "data": { … } }
```

On error: `{ "success": false, "message": "…" }` with an HTTP 4xx/5xx status.

---

## 2. Endpoints

### 2.1 Create a product request

Customer submits a product they want.

```
POST /food/user/product-requests
```

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `productName` | string | ✅ Yes | What the customer wants. Non-empty. |
| `brand` | string | optional | Preferred brand, if any. |
| `category` | string | optional | e.g. "Spreads", "Dairy". |
| `quantity` | string | optional | Free text, e.g. "2 jars", "500g". |
| `note` | string | optional | Any extra detail. (`description` is also accepted as an alias.) |

Example:

```json
{
  "productName": "Organic Almond Butter 500g",
  "brand": "Nutty Co",
  "category": "Spreads",
  "quantity": "2 jars",
  "note": "Please stock the unsweetened one"
}
```

**Success — `201 Created`**

```json
{
  "success": true,
  "message": "Product request submitted",
  "data": {
    "request": {
      "_id": "6ac73914518e9f019e706813",
      "userId": "6a9ea215db9969e6a81adecf",
      "productName": "Organic Almond Butter 500g",
      "brand": "Nutty Co",
      "category": "Spreads",
      "quantity": "2 jars",
      "note": "Please stock the unsweetened one",
      "customerName": "Smoke Test",
      "customerPhone": "9000000001",
      "status": "pending",
      "adminResponse": "",
      "createdAt": "2026-10-08T06:32:52.835Z",
      "updatedAt": "2026-10-08T06:32:52.835Z"
    }
  }
}
```

**Errors**

| Status | `message` | When |
|---|---|---|
| 400 | `productName is required` | Missing/empty `productName`. |
| 401 | `Authentication token missing` | No/invalid `Authorization` header. |
| 401 | `Unauthorized or invalid user` | Token not a valid user. |

> `customerName` / `customerPhone` are filled **server-side** from the logged-in
> account — do **not** send them.

---

### 2.2 List my product requests

The customer's own request history (newest first).

```
GET /food/user/product-requests?page=1&limit=20
```

**Query params**

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | int | 1 | 1-based. |
| `limit` | int | 20 | Max 50. |

**Success — `200 OK`**

```json
{
  "success": true,
  "message": "Product requests fetched",
  "data": {
    "requests": [
      {
        "_id": "6ac73914518e9f019e706813",
        "productName": "Organic Almond Butter 500g",
        "brand": "Nutty Co",
        "category": "Spreads",
        "quantity": "2 jars",
        "note": "Please stock the unsweetened one",
        "status": "approved",
        "adminResponse": "We'll stock this next week.",
        "createdAt": "2026-10-08T06:32:52.835Z",
        "updatedAt": "2026-10-08T07:10:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "limit": 20
  }
}
```

Only the signed-in customer's own requests are returned.

---

## 3. Status values

`status` is controlled by the admin. The app should treat it as read-only and
just display it (and `adminResponse` when present).

| `status` | Meaning (show to customer) |
|---|---|
| `pending` | Received, not reviewed yet. |
| `reviewed` | Admin has seen it. |
| `approved` | Will be sourced/added. |
| `rejected` | Won't be added (see `adminResponse`). |
| `fulfilled` | Now available in the catalog. |

Suggested UI labels/colors: pending = grey/amber, reviewed = blue, approved =
green, rejected = red, fulfilled = teal. `adminResponse` is an optional admin
note — show it under the status if non-empty.

---

## 4. Flutter examples

### Using `dio`

```dart
// Create a request
Future<void> requestProduct(Dio dio, String token) async {
  final res = await dio.post(
    '/food/user/product-requests',
    data: {
      'productName': 'Organic Almond Butter 500g',
      'brand': 'Nutty Co',        // optional
      'category': 'Spreads',      // optional
      'quantity': '2 jars',       // optional
      'note': 'Unsweetened only', // optional
    },
    options: Options(headers: {'Authorization': 'Bearer $token'}),
  );
  // res.data['data']['request'] -> the created request
}

// List my requests
Future<List<dynamic>> myProductRequests(Dio dio, String token,
    {int page = 1, int limit = 20}) async {
  final res = await dio.get(
    '/food/user/product-requests',
    queryParameters: {'page': page, 'limit': limit},
    options: Options(headers: {'Authorization': 'Bearer $token'}),
  );
  return res.data['data']['requests'] as List<dynamic>;
}
```

### Using `http`

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;

final base = 'https://<API_HOST>/api/v1';

Future<Map<String, dynamic>> createProductRequest(
    String token, Map<String, dynamic> body) async {
  final r = await http.post(
    Uri.parse('$base/food/user/product-requests'),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer $token',
    },
    body: jsonEncode(body),
  );
  return jsonDecode(r.body) as Map<String, dynamic>;
}
```

---

## 5. Suggested UX

1. On a "product not found" / empty search, show a **"Request this product"** button.
2. Tapping it opens a small form: product name (required) + optional brand /
   category / quantity / note.
3. On submit → `POST /food/user/product-requests`; show a success toast
   ("We've noted your request").
4. A **"My Requests"** list (in Profile) → `GET /food/user/product-requests`,
   showing each item with its status badge and any `adminResponse`.

---

## 6. Quick reference

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/food/user/product-requests` | Submit a new product request |
| `GET` | `/food/user/product-requests` | List the customer's own requests |

Both require `Authorization: Bearer <USER token>`.
