-- name: fn_stock_balance
-- type: function
-- purpose: Stock of a product at a warehouse recomputed from the movement ledger.
-- depends: inventory_movements
-- example: SELECT product_id, warehouse_id, quantity_on_hand, fn_stock_balance(product_id, warehouse_id) AS ledger FROM inventory ORDER BY product_id LIMIT 5
CREATE OR REPLACE FUNCTION fn_stock_balance(p_product_id BIGINT UNSIGNED, p_warehouse_id SMALLINT UNSIGNED)
RETURNS INT
READS SQL DATA
SQL SECURITY INVOKER
COMMENT 'mariadb-data-lab: stock from movement ledger'
RETURN (SELECT COALESCE(SUM(quantity), 0) FROM inventory_movements WHERE product_id = p_product_id AND warehouse_id = p_warehouse_id)
