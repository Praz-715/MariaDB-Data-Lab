-- name: trg_return_items_quantity_guard
-- type: trigger
-- purpose: Rejects a return line when the total returned quantity would exceed the purchased quantity (enforces the rule in the database, not only in validation).
-- depends: return_items, order_items
-- note: Runs for every return_items insert, including generation; cost is one primary-key lookup and one indexed sum per row.
CREATE OR REPLACE TRIGGER trg_return_items_quantity_guard
BEFORE INSERT ON return_items
FOR EACH ROW
BEGIN
  DECLARE v_purchased INT DEFAULT 0;
  DECLARE v_returned INT DEFAULT 0;
  SELECT COALESCE(SUM(quantity), 0) INTO v_purchased FROM order_items WHERE order_id = NEW.order_id AND item_seq = NEW.item_seq;
  SELECT COALESCE(SUM(quantity), 0) INTO v_returned FROM return_items WHERE order_id = NEW.order_id AND item_seq = NEW.item_seq;
  IF v_returned + NEW.quantity > v_purchased THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Returned quantity exceeds purchased quantity';
  END IF;
END
