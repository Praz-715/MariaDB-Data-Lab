-- Example queries for checking generated data by hand (mariadb client or any SQL tool).
-- Run them in the lab schema, e.g.:  USE datalab;
-- The Data Generator's "Run validation" button executes 27 stricter rules automatically.

-- 1. Row counts of the main tables (exact).
SELECT 'customers' AS t, COUNT(*) FROM customers
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'shipments', COUNT(*) FROM shipments;

-- 2. Payments reconcile with order totals (expect 0 rows).
SELECT o.order_id, o.total_amount, SUM(p.amount) AS paid
  FROM orders o JOIN payments p ON p.order_id = o.order_id
 GROUP BY o.order_id, o.total_amount
HAVING paid <> o.total_amount
 LIMIT 20;

-- 3. Order totals match their lines (expect 0 rows).
SELECT o.order_id
  FROM orders o
  JOIN (SELECT order_id, SUM(quantity * unit_price) AS s, SUM(freight_amount) AS f FROM order_items GROUP BY order_id) i
    ON i.order_id = o.order_id
 WHERE o.items_subtotal <> i.s OR o.shipping_total <> i.f
 LIMIT 20;

-- 4. Stock balances equal the movement ledger (expect 0 rows).
SELECT i.product_id, i.warehouse_id, i.quantity_on_hand, SUM(m.quantity) AS ledger
  FROM inventory i JOIN inventory_movements m ON m.product_id = i.product_id AND m.warehouse_id = i.warehouse_id
 GROUP BY i.product_id, i.warehouse_id, i.quantity_on_hand
HAVING ledger <> i.quantity_on_hand
 LIMIT 20;

-- 5. Deliveries never precede purchase (expect 0).
SELECT COUNT(*) FROM orders WHERE delivered_at < purchased_at;

-- 6. Returned quantity never exceeds purchased quantity (expect 0 rows).
SELECT r.order_id, r.item_seq, SUM(r.quantity) AS returned, i.quantity
  FROM return_items r JOIN order_items i ON i.order_id = r.order_id AND i.item_seq = r.item_seq
 GROUP BY r.order_id, r.item_seq, i.quantity
HAVING returned > i.quantity;

-- 7. Realism: order status mix, payment mix, monthly seasonality.
SELECT status, COUNT(*) AS orders, ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct FROM orders GROUP BY status ORDER BY orders DESC;
SELECT payment_method, COUNT(*) AS n FROM payments GROUP BY payment_method ORDER BY n DESC;
SELECT DATE_FORMAT(sales_date, '%Y-%m') AS month, SUM(orders_count) AS orders, SUM(net_revenue) AS revenue
  FROM daily_sales_summary GROUP BY month ORDER BY month;

-- 8. Late deliveries and their effect on ratings.
SELECT (o.delivered_at > o.estimated_delivery_at) AS late, COUNT(*) AS reviews, ROUND(AVG(r.rating), 2) AS avg_rating
  FROM product_reviews r JOIN orders o ON o.order_id = r.order_id
 GROUP BY late;

-- 9. Top 10 products by revenue (uses idx_order_items_product).
SELECT p.product_id, p.product_name, c.category_name, SUM(oi.quantity * oi.unit_price) AS revenue
  FROM order_items oi
  JOIN orders o ON o.order_id = oi.order_id AND o.status NOT IN ('canceled', 'unavailable')
  JOIN products p ON p.product_id = oi.product_id
  JOIN product_categories c ON c.category_id = p.category_id
 GROUP BY p.product_id, p.product_name, c.category_name
 ORDER BY revenue DESC
 LIMIT 10;

-- 10. Repeat-purchase rate among buyers.
SELECT ROUND(100 * SUM(n > 1) / COUNT(*), 1) AS repeat_buyer_pct
  FROM (SELECT customer_id, COUNT(*) AS n FROM orders GROUP BY customer_id) x;

-- 11. Rows written per table by each generation job.
SELECT job_id, table_name, rows_inserted, seed, recorded_at FROM data_generation_audit ORDER BY recorded_at DESC, table_name LIMIT 40;
