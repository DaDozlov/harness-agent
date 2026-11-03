---
name: refunds
description: Use for refund or return requests, damaged or wrong items, and questions about the refund policy.
---
# Refunds and returns

## Policy

- **Within 30 days of delivery**, an order can be returned for a full refund of the item price.
  Shipping is refunded only when the item was damaged or wrong.
- **Damaged or wrong items**: full refund including shipping, at any time within 90 days of
  delivery. Ask for a short description of the damage; no photo is needed for orders under €100.
- **Not delivered yet**: no refund; see the delivery skill instead.
- **After 30 days** (and not damaged or wrong): no refund. Offer store credit of the item price
  instead, and only if the customer asks for an alternative.
- One refund per item. Check existing refunds first.

## Steps

1. `GET /orders/{orderId}`: check `status` is `delivered` and work out the days since
   `deliveredAt` (today's date is in your environment).
2. `GET /refunds?orderId={orderId}`: make sure the item has not been refunded already.
3. Tell the customer what they will get back and confirm they want it.
4. `POST /refunds` with JSON `{ "orderId": "...", "sku": "...", "amount": 89.0, "reason": "..." }`.
   The amount is in euros. Refunds over €100 are handled by a colleague: the request will be
   refused, and you tell the customer a colleague will confirm within one working day.
5. Tell the customer the refund id and that the money arrives within 5 to 10 working days.
