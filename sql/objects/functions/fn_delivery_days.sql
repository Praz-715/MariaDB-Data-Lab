-- name: fn_delivery_days
-- type: function
-- purpose: Days from purchase to delivery (NULL until delivered).
-- depends: orders
-- example: SELECT order_id, status, fn_delivery_days(order_id) AS days FROM orders WHERE status = 'delivered' ORDER BY order_id LIMIT 5
CREATE OR REPLACE FUNCTION fn_delivery_days(p_order_id BIGINT UNSIGNED)
RETURNS DECIMAL(8,2)
READS SQL DATA
SQL SECURITY INVOKER
COMMENT 'mariadb-data-lab: purchase-to-delivery days'
RETURN (SELECT ROUND(TIMESTAMPDIFF(MINUTE, purchased_at, delivered_at) / 1440, 2) FROM orders WHERE order_id = p_order_id)
