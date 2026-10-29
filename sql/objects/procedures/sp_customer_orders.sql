-- name: sp_customer_orders
-- type: procedure
-- purpose: Latest orders of a customer (uses idx_orders_customer_purchased), with item count and payment balance.
-- depends: orders, order_items, fn_order_balance
-- example: CALL sp_customer_orders((SELECT customer_id FROM orders ORDER BY order_id LIMIT 1), 10)
CREATE OR REPLACE PROCEDURE sp_customer_orders(IN p_customer_id BIGINT UNSIGNED, IN p_limit INT)
READS SQL DATA
SQL SECURITY INVOKER
COMMENT 'mariadb-data-lab: recent orders of one customer'
BEGIN
  -- LIMIT in a routine takes a literal or a local variable, not an expression.
  DECLARE v_limit INT DEFAULT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 200);
  SELECT o.order_id, o.order_code, o.status, o.purchased_at, o.total_amount,
         (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.order_id) AS line_count,
         fn_order_balance(o.order_id) AS balance
    FROM orders o
   WHERE o.customer_id = p_customer_id
   ORDER BY o.purchased_at DESC
   LIMIT v_limit;
END
