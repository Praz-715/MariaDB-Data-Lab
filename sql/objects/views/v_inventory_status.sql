-- name: v_inventory_status
-- type: view
-- purpose: Stock positions with product, warehouse and a reorder flag.
-- depends: inventory, products, warehouses
-- example: SELECT * FROM v_inventory_status WHERE needs_reorder = 1 ORDER BY quantity_on_hand LIMIT 10
CREATE OR REPLACE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW v_inventory_status AS
SELECT i.product_id, p.sku, p.product_name, i.warehouse_id, w.warehouse_code,
       i.quantity_on_hand, i.reorder_level, (i.quantity_on_hand <= i.reorder_level) AS needs_reorder, i.updated_at
  FROM inventory i
  JOIN products p ON p.product_id = i.product_id
  JOIN warehouses w ON w.warehouse_id = i.warehouse_id
