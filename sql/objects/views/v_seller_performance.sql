-- name: v_seller_performance
-- type: view
-- purpose: Fulfilment performance per seller: shipments, delivered share, late share and average transit days. Filter on seller_id for cheap lookups (condition pushdown).
-- depends: shipments
-- example: SELECT * FROM v_seller_performance WHERE seller_id BETWEEN 1 AND 10
CREATE OR REPLACE SQL SECURITY INVOKER VIEW v_seller_performance AS
SELECT s.seller_id,
       COUNT(*) AS shipments,
       SUM(s.status = 'delivered') AS delivered,
       ROUND(AVG(s.delivered_at > s.estimated_delivery_at), 4) AS late_share,
       ROUND(AVG(TIMESTAMPDIFF(MINUTE, s.shipped_at, s.delivered_at)) / 1440, 2) AS avg_transit_days,
       SUM(s.shipping_cost) AS freight_revenue
  FROM shipments s
 GROUP BY s.seller_id
