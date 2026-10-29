-- name: sp_order_health
-- type: procedure
-- purpose: Business-rule health of one order: payment balance, subtotal check, shipment states, lateness.
-- depends: orders, order_items, shipments, fn_order_balance
-- example: CALL sp_order_health((SELECT MIN(order_id) FROM orders))
CREATE OR REPLACE PROCEDURE sp_order_health(IN p_order_id BIGINT UNSIGNED)
READS SQL DATA
SQL SECURITY INVOKER
COMMENT 'mariadb-data-lab: order business-rule check'
BEGIN
  SELECT o.order_id, o.status, o.total_amount,
         fn_order_balance(o.order_id) AS payment_balance,
         o.items_subtotal = (SELECT SUM(i.quantity * i.unit_price) FROM order_items i WHERE i.order_id = o.order_id) AS subtotal_matches_items,
         (SELECT COUNT(*) FROM shipments s WHERE s.order_id = o.order_id) AS shipments,
         (SELECT COUNT(*) FROM shipments s WHERE s.order_id = o.order_id AND s.status = 'delivered') AS delivered_shipments,
         o.delivered_at > o.estimated_delivery_at AS is_late
    FROM orders o
   WHERE o.order_id = p_order_id;
END
