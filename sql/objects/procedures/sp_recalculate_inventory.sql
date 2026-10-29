-- name: sp_recalculate_inventory
-- type: procedure
-- purpose: Resets quantity_on_hand from the movement ledger for a product id range and reports how many positions changed.
-- depends: inventory, inventory_movements
-- example: CALL sp_recalculate_inventory(1, 500)
CREATE OR REPLACE PROCEDURE sp_recalculate_inventory(IN p_product_from BIGINT UNSIGNED, IN p_product_to BIGINT UNSIGNED)
MODIFIES SQL DATA
SQL SECURITY INVOKER
COMMENT 'mariadb-data-lab: recompute stock balances'
BEGIN
  IF p_product_to - p_product_from > 1000000 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Range too large: recalculate at most 1,000,000 products per call';
  END IF;
  UPDATE inventory i
    JOIN (SELECT product_id, warehouse_id, SUM(quantity) AS bal FROM inventory_movements
           WHERE product_id BETWEEN p_product_from AND p_product_to GROUP BY product_id, warehouse_id) m
      ON m.product_id = i.product_id AND m.warehouse_id = i.warehouse_id
     SET i.quantity_on_hand = m.bal
   WHERE i.product_id BETWEEN p_product_from AND p_product_to AND i.quantity_on_hand <> m.bal;
  SELECT ROW_COUNT() AS positions_corrected;
END
