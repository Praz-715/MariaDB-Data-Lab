-- name: idx_order_items_product_sales
-- type: index
-- table: order_items
-- purpose: Covering index for revenue per product (top products, product performance). The query reads only the index instead of every order line.
-- explain: SELECT product_id, SUM(quantity * unit_price) AS revenue FROM order_items GROUP BY product_id ORDER BY revenue DESC LIMIT 10
CREATE INDEX IF NOT EXISTS idx_order_items_product_sales ON order_items (product_id, quantity, unit_price) ALGORITHM=INPLACE LOCK=NONE
