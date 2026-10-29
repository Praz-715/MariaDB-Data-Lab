-- name: trg_orders_status_transition
-- type: trigger
-- purpose: Allows only valid lifecycle moves on UPDATE: created -> approved/canceled, approved -> shipped/canceled/unavailable, shipped -> delivered.
-- depends: orders
-- note: Fires on UPDATE only; generation and import insert orders and are not affected.
CREATE OR REPLACE TRIGGER trg_orders_status_transition
BEFORE UPDATE ON orders
FOR EACH ROW
BEGIN
  IF NOT (OLD.status <=> NEW.status) AND NOT (
       (OLD.status = 'created' AND NEW.status IN ('approved', 'canceled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('shipped', 'canceled', 'unavailable'))
    OR (OLD.status = 'shipped' AND NEW.status = 'delivered')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid order status transition';
  END IF;
END
