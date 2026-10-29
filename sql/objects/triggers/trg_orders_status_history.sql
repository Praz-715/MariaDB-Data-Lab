-- name: trg_orders_status_history
-- type: trigger
-- purpose: Records every order status change in order_status_history.
-- depends: orders, order_status_history
-- note: Fires on UPDATE only.
CREATE OR REPLACE TRIGGER trg_orders_status_history
AFTER UPDATE ON orders
FOR EACH ROW
BEGIN
  IF NOT (OLD.status <=> NEW.status) THEN
    INSERT INTO order_status_history (order_id, old_status, new_status, changed_at)
    VALUES (NEW.order_id, OLD.status, NEW.status, UTC_TIMESTAMP());
  END IF;
END
