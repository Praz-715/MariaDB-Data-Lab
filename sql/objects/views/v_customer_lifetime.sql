-- name: v_customer_lifetime
-- type: view
-- purpose: Lifetime value per customer. Aggregating view: a WHERE on customer_id is pushed into the GROUP BY by MariaDB's derived-table condition pushdown, so single-customer lookups stay cheap; unfiltered scans aggregate every order.
-- depends: orders
-- example: SELECT * FROM v_customer_lifetime WHERE customer_id BETWEEN 1 AND 20
CREATE OR REPLACE SQL SECURITY INVOKER VIEW v_customer_lifetime AS
SELECT o.customer_id,
       MIN(o.purchased_at) AS first_order_at,
       MAX(o.purchased_at) AS last_order_at,
       COUNT(*) AS orders,
       SUM(o.status = 'delivered') AS delivered_orders,
       SUM(IF(o.status IN ('canceled', 'unavailable'), 0, o.total_amount)) AS lifetime_revenue,
       ROUND(AVG(IF(o.status IN ('canceled', 'unavailable'), NULL, o.total_amount)), 2) AS avg_order_value
  FROM orders o
 GROUP BY o.customer_id
