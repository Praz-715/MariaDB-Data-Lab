-- name: sp_refresh_sales_summaries
-- type: procedure
-- purpose: Recomputes daily_sales_summary for a date range and monthly_sales_summary for the months it touches (idempotent upserts; same rules as the generator's final phase).
-- depends: orders, order_items, products, daily_sales_summary, monthly_sales_summary
-- example: CALL sp_refresh_sales_summaries('2026-06-01', '2026-06-30')
CREATE OR REPLACE PROCEDURE sp_refresh_sales_summaries(IN p_from DATE, IN p_to DATE)
MODIFIES SQL DATA
SQL SECURITY INVOKER
COMMENT 'mariadb-data-lab: refresh sales summary tables'
BEGIN
  DECLARE v_month_from DATE DEFAULT DATE_FORMAT(p_from, '%Y-%m-01');
  DECLARE v_month_to DATE DEFAULT DATE_FORMAT(p_to, '%Y-%m-01') + INTERVAL 1 MONTH;
  DECLARE v_daily INT DEFAULT 0;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'p_from and p_to are required and p_to must not precede p_from';
  END IF;

  INSERT INTO daily_sales_summary
    (sales_date, orders_count, delivered_orders, canceled_orders, items_sold, gross_merchandise, shipping_revenue,
     discounts, net_revenue, unique_customers, refreshed_at)
  SELECT DATE(x.purchased_at), COUNT(*), SUM(x.status = 'delivered'), SUM(x.status IN ('canceled', 'unavailable')),
         SUM(IF(x.valid, x.units, 0)), SUM(IF(x.valid, x.items_subtotal, 0)), SUM(IF(x.valid, x.shipping_total, 0)),
         SUM(IF(x.valid, x.discount_total, 0)), SUM(IF(x.valid, x.total_amount, 0)), COUNT(DISTINCT x.customer_id), UTC_TIMESTAMP()
    FROM (SELECT o.purchased_at, o.status, o.customer_id, o.items_subtotal, o.shipping_total, o.discount_total, o.total_amount,
                 o.status NOT IN ('canceled', 'unavailable') AS valid,
                 (SELECT SUM(oi.quantity) FROM order_items oi WHERE oi.order_id = o.order_id) AS units
            FROM orders o WHERE o.purchased_at >= p_from AND o.purchased_at < p_to + INTERVAL 1 DAY) x
   GROUP BY DATE(x.purchased_at)
  ON DUPLICATE KEY UPDATE orders_count = VALUES(orders_count), delivered_orders = VALUES(delivered_orders),
    canceled_orders = VALUES(canceled_orders), items_sold = VALUES(items_sold), gross_merchandise = VALUES(gross_merchandise),
    shipping_revenue = VALUES(shipping_revenue), discounts = VALUES(discounts), net_revenue = VALUES(net_revenue),
    unique_customers = VALUES(unique_customers), refreshed_at = VALUES(refreshed_at);
  SET v_daily = ROW_COUNT();

  INSERT INTO monthly_sales_summary (month_start, category_id, orders_count, items_sold, revenue, refreshed_at)
  SELECT DATE_FORMAT(o.purchased_at, '%Y-%m-01'), p.category_id, COUNT(DISTINCT o.order_id), SUM(oi.quantity),
         SUM(oi.quantity * oi.unit_price), UTC_TIMESTAMP()
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.order_id
    JOIN products p ON p.product_id = oi.product_id
   WHERE o.purchased_at >= v_month_from AND o.purchased_at < v_month_to AND o.status NOT IN ('canceled', 'unavailable')
   GROUP BY 1, 2
  ON DUPLICATE KEY UPDATE orders_count = VALUES(orders_count), items_sold = VALUES(items_sold),
    revenue = VALUES(revenue), refreshed_at = VALUES(refreshed_at);

  SELECT v_daily AS daily_rows_affected, ROW_COUNT() AS monthly_rows_affected;
END
