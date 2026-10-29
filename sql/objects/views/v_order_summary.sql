-- name: v_order_summary
-- type: view
-- purpose: One row per order with customer geography, money, delivery time and lateness. Plain joins keep it MERGE-able, so filters reach the base-table indexes.
-- depends: orders, customers, customer_addresses, geographic_locations
-- example: SELECT * FROM v_order_summary WHERE purchased_at >= '2026-06-01' ORDER BY purchased_at LIMIT 10
CREATE OR REPLACE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW v_order_summary AS
SELECT o.order_id, o.order_code, o.status, o.purchased_at, o.approved_at, o.delivered_at, o.estimated_delivery_at,
       o.customer_id, c.segment_id, g.state_code AS customer_state, g.region AS customer_region,
       o.items_subtotal, o.shipping_total, o.discount_total, o.total_amount,
       ROUND(TIMESTAMPDIFF(MINUTE, o.purchased_at, o.delivered_at) / 1440, 2) AS delivery_days,
       (o.delivered_at > o.estimated_delivery_at) AS is_late
  FROM orders o
  JOIN customers c ON c.customer_id = o.customer_id
  JOIN customer_addresses a ON a.customer_id = o.customer_id AND a.address_seq = o.shipping_address_seq
  JOIN geographic_locations g ON g.location_id = a.location_id
