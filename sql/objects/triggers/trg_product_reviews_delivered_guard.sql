-- name: trg_product_reviews_delivered_guard
-- type: trigger
-- purpose: Rejects reviews for orders that are not delivered, or dated before delivery.
-- depends: product_reviews, orders
-- note: Runs for every review insert, including generation and import; cost is one primary-key lookup per row.
CREATE OR REPLACE TRIGGER trg_product_reviews_delivered_guard
BEFORE INSERT ON product_reviews
FOR EACH ROW
BEGIN
  DECLARE v_status VARCHAR(20);
  DECLARE v_delivered DATETIME;
  SELECT status, delivered_at INTO v_status, v_delivered FROM orders WHERE order_id = NEW.order_id;
  IF v_status IS NULL OR v_status <> 'delivered' OR NEW.created_at < v_delivered THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Reviews require a delivered order and must be dated after delivery';
  END IF;
END
