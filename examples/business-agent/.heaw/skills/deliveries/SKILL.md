---
name: deliveries
description: Use for questions about where an order is, delivery dates, delays and lost parcels.
---
# Deliveries

1. `GET /orders/{orderId}` and look at `status`, `shippedAt` and `shipment`.
2. Answer by status:
   - `processing`: it leaves the warehouse within 2 working days of the order.
   - `shipped`: give the carrier and tracking number from `shipment`. Delivery takes 2 to 4
     working days in the EU.
   - `delayed`: apologise, give the new estimate from `shipment.estimatedDelivery`, and offer to
     cancel for a full refund (the refunds skill) if it is more than 7 days later than first
     promised.
   - `delivered`: give the date. If the customer has not received it, a colleague opens an
     investigation with the carrier: say so, and that they will hear back within 3 working days.
3. Never promise a date the API does not give.
