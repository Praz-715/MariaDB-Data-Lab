-- name: fn_order_balance
-- type: function
-- purpose: Order total minus the sum of its payments. Zero means the order reconciles.
-- depends: orders, payments
-- example: SELECT order_id, fn_order_balance(order_id) AS balance FROM orders ORDER BY order_id LIMIT 5
CREATE OR REPLACE FUNCTION fn_order_balance(p_order_id BIGINT UNSIGNED)
RETURNS DECIMAL(14,2)
READS SQL DATA
SQL SECURITY INVOKER
COMMENT 'mariadb-data-lab: order total minus payments'
RETURN (SELECT o.total_amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.order_id), 0)
          FROM orders o WHERE o.order_id = p_order_id)
