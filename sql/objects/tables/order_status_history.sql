-- name: order_status_history
-- type: table
-- purpose: Audit trail of order status changes, written by trg_orders_status_history.
-- depends: orders
CREATE TABLE IF NOT EXISTS order_status_history (
  history_id  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id    BIGINT UNSIGNED NOT NULL,
  old_status  VARCHAR(20)     NOT NULL,
  new_status  VARCHAR(20)     NOT NULL,
  changed_at  DATETIME        NOT NULL,
  PRIMARY KEY (history_id),
  KEY idx_order_status_history_order (order_id, changed_at),
  CONSTRAINT fk_order_status_history_order FOREIGN KEY (order_id) REFERENCES orders (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Managed by MariaDB Data Lab object generator'
