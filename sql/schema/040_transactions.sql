-- Transactional data: the order lifecycle and everything hanging off it.
-- Dependent entities use composite natural keys (order_id, seq) so the generator can
-- produce identical keys on every run and on resume.

CREATE TABLE IF NOT EXISTS orders (
  order_id               BIGINT UNSIGNED  NOT NULL,
  order_code             CHAR(14)         NOT NULL,
  customer_id            BIGINT UNSIGNED  NOT NULL,
  shipping_address_seq   TINYINT UNSIGNED NOT NULL,
  status                 ENUM('created','approved','shipped','delivered','canceled','unavailable') NOT NULL,
  currency_code          CHAR(3)          NOT NULL,
  items_subtotal         DECIMAL(14,2)    NOT NULL,
  shipping_total         DECIMAL(14,2)    NOT NULL,
  discount_total         DECIMAL(14,2)    NOT NULL DEFAULT 0,
  total_amount           DECIMAL(14,2)    NOT NULL,
  purchased_at           DATETIME         NOT NULL,
  approved_at            DATETIME         NULL,
  estimated_delivery_at  DATETIME         NULL,
  delivered_at           DATETIME         NULL,
  canceled_at            DATETIME         NULL,
  PRIMARY KEY (order_id),
  UNIQUE KEY uq_orders_code (order_code),
  KEY idx_orders_customer_purchased (customer_id, purchased_at),
  KEY idx_orders_purchased (purchased_at),
  KEY idx_orders_status_purchased (status, purchased_at),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (customer_id),
  CONSTRAINT fk_orders_shipping_address FOREIGN KEY (customer_id, shipping_address_seq)
    REFERENCES customer_addresses (customer_id, address_seq),
  CONSTRAINT fk_orders_currency FOREIGN KEY (currency_code) REFERENCES currencies (currency_code),
  CONSTRAINT chk_orders_amounts CHECK (items_subtotal > 0 AND shipping_total >= 0 AND discount_total >= 0 AND discount_total <= items_subtotal),
  CONSTRAINT chk_orders_total CHECK (total_amount = items_subtotal + shipping_total - discount_total),
  CONSTRAINT chk_orders_approved CHECK (approved_at IS NULL OR approved_at >= purchased_at),
  CONSTRAINT chk_orders_delivered CHECK (delivered_at IS NULL OR (approved_at IS NOT NULL AND delivered_at >= approved_at)),
  CONSTRAINT chk_orders_canceled CHECK (canceled_at IS NULL OR canceled_at >= purchased_at),
  CONSTRAINT chk_orders_status_dates CHECK (
    (status <> 'delivered' OR delivered_at IS NOT NULL)
    AND (status NOT IN ('canceled','unavailable') OR canceled_at IS NOT NULL)
    AND (status IN ('canceled','unavailable') OR canceled_at IS NULL)
    AND (status = 'created' OR status IN ('canceled','unavailable') OR approved_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shipments (
  order_id                 BIGINT UNSIGNED   NOT NULL,
  shipment_seq             TINYINT UNSIGNED  NOT NULL,
  seller_id                INT UNSIGNED      NOT NULL,
  warehouse_id             SMALLINT UNSIGNED NOT NULL,
  carrier_id               SMALLINT UNSIGNED NOT NULL,
  tracking_number          VARCHAR(24)       NOT NULL,
  status                   ENUM('label_created','in_transit','delivered') NOT NULL,
  shipping_cost            DECIMAL(12,2)     NOT NULL,
  weight_g                 INT UNSIGNED      NOT NULL,
  destination_location_id  INT UNSIGNED      NOT NULL,
  created_at               DATETIME          NOT NULL,
  shipped_at               DATETIME          NULL,
  estimated_delivery_at    DATETIME          NOT NULL,
  delivered_at             DATETIME          NULL,
  PRIMARY KEY (order_id, shipment_seq),
  UNIQUE KEY uq_shipments_tracking (tracking_number),
  KEY idx_shipments_seller (seller_id),
  KEY idx_shipments_warehouse (warehouse_id),
  KEY idx_shipments_carrier_shipped (carrier_id, shipped_at),
  KEY idx_shipments_destination (destination_location_id),
  KEY idx_shipments_status (status),
  CONSTRAINT fk_shipments_order FOREIGN KEY (order_id) REFERENCES orders (order_id),
  CONSTRAINT fk_shipments_seller FOREIGN KEY (seller_id) REFERENCES sellers (seller_id),
  CONSTRAINT fk_shipments_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses (warehouse_id),
  CONSTRAINT fk_shipments_carrier FOREIGN KEY (carrier_id) REFERENCES shipping_carriers (carrier_id),
  CONSTRAINT fk_shipments_destination FOREIGN KEY (destination_location_id) REFERENCES geographic_locations (location_id),
  CONSTRAINT chk_shipments_cost CHECK (shipping_cost >= 0 AND weight_g > 0),
  CONSTRAINT chk_shipments_dates CHECK (
    (shipped_at IS NULL OR shipped_at >= created_at)
    AND (delivered_at IS NULL OR (shipped_at IS NOT NULL AND delivered_at >= shipped_at))),
  CONSTRAINT chk_shipments_status CHECK (
    (status = 'label_created' AND shipped_at IS NULL AND delivered_at IS NULL)
    OR (status = 'in_transit' AND shipped_at IS NOT NULL AND delivered_at IS NULL)
    OR (status = 'delivered' AND delivered_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_items (
  order_id       BIGINT UNSIGNED   NOT NULL,
  item_seq       SMALLINT UNSIGNED NOT NULL,
  product_id     BIGINT UNSIGNED   NOT NULL,
  shipment_seq   TINYINT UNSIGNED  NULL,
  quantity       SMALLINT UNSIGNED NOT NULL,
  unit_price     DECIMAL(12,2)     NOT NULL,
  freight_amount DECIMAL(12,2)     NOT NULL,
  PRIMARY KEY (order_id, item_seq),
  KEY idx_order_items_product (product_id),
  KEY idx_order_items_shipment (order_id, shipment_seq),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders (order_id),
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products (product_id),
  CONSTRAINT fk_order_items_shipment FOREIGN KEY (order_id, shipment_seq) REFERENCES shipments (order_id, shipment_seq),
  CONSTRAINT chk_order_items_values CHECK (quantity > 0 AND unit_price > 0 AND freight_amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shipment_tracking_events (
  order_id      BIGINT UNSIGNED  NOT NULL,
  shipment_seq  TINYINT UNSIGNED NOT NULL,
  event_seq     TINYINT UNSIGNED NOT NULL,
  event_type    ENUM('label_created','picked_up','in_transit','out_for_delivery','delivery_failed','delivered') NOT NULL,
  event_at      DATETIME         NOT NULL,
  location_id   INT UNSIGNED     NOT NULL,
  description   VARCHAR(160)     NOT NULL,
  PRIMARY KEY (order_id, shipment_seq, event_seq),
  KEY idx_tracking_events_event_at (event_at),
  KEY idx_tracking_events_location (location_id),
  CONSTRAINT fk_tracking_events_shipment FOREIGN KEY (order_id, shipment_seq) REFERENCES shipments (order_id, shipment_seq),
  CONSTRAINT fk_tracking_events_location FOREIGN KEY (location_id) REFERENCES geographic_locations (location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  order_id        BIGINT UNSIGNED  NOT NULL,
  payment_seq     TINYINT UNSIGNED NOT NULL,
  payment_method  ENUM('credit_card','boleto','pix','voucher','debit_card') NOT NULL,
  installments    TINYINT UNSIGNED NOT NULL DEFAULT 1,
  amount          DECIMAL(14,2)    NOT NULL,
  status          ENUM('pending','captured','failed','voided','refunded','partially_refunded') NOT NULL,
  created_at      DATETIME         NOT NULL,
  captured_at     DATETIME         NULL,
  PRIMARY KEY (order_id, payment_seq),
  KEY idx_payments_method (payment_method),
  KEY idx_payments_status (status),
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders (order_id),
  CONSTRAINT chk_payments_amount CHECK (amount > 0),
  CONSTRAINT chk_payments_installments CHECK (installments BETWEEN 1 AND 24 AND (payment_method = 'credit_card' OR installments = 1)),
  CONSTRAINT chk_payments_captured CHECK (captured_at IS NULL OR captured_at >= created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_transactions (
  order_id       BIGINT UNSIGNED  NOT NULL,
  payment_seq    TINYINT UNSIGNED NOT NULL,
  txn_seq        TINYINT UNSIGNED NOT NULL,
  txn_type       ENUM('authorization','capture','refund','void') NOT NULL,
  txn_status     ENUM('success','declined') NOT NULL,
  amount         DECIMAL(14,2)    NOT NULL,
  processor_ref  VARCHAR(40)      NOT NULL,
  created_at     DATETIME         NOT NULL,
  PRIMARY KEY (order_id, payment_seq, txn_seq),
  UNIQUE KEY uq_payment_transactions_ref (processor_ref),
  KEY idx_payment_transactions_created (created_at),
  CONSTRAINT fk_payment_transactions_payment FOREIGN KEY (order_id, payment_seq) REFERENCES payments (order_id, payment_seq),
  CONSTRAINT chk_payment_transactions_amount CHECK (amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_returns (
  order_id       BIGINT UNSIGNED  NOT NULL,
  return_seq     TINYINT UNSIGNED NOT NULL,
  status         ENUM('requested','rejected','received','refunded') NOT NULL,
  reason         ENUM('defective','damaged_in_transit','wrong_item','not_as_described','late_delivery','changed_mind') NOT NULL,
  requested_at   DATETIME         NOT NULL,
  received_at    DATETIME         NULL,
  refunded_at    DATETIME         NULL,
  refund_amount  DECIMAL(14,2)    NOT NULL,
  PRIMARY KEY (order_id, return_seq),
  KEY idx_order_returns_requested (requested_at),
  KEY idx_order_returns_reason (reason),
  CONSTRAINT fk_order_returns_order FOREIGN KEY (order_id) REFERENCES orders (order_id),
  CONSTRAINT chk_order_returns_amount CHECK (refund_amount >= 0),
  CONSTRAINT chk_order_returns_dates CHECK (
    (received_at IS NULL OR received_at >= requested_at)
    AND (refunded_at IS NULL OR (received_at IS NOT NULL AND refunded_at >= received_at)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS return_items (
  order_id    BIGINT UNSIGNED   NOT NULL,
  return_seq  TINYINT UNSIGNED  NOT NULL,
  item_seq    SMALLINT UNSIGNED NOT NULL,
  quantity    SMALLINT UNSIGNED NOT NULL,
  item_condition ENUM('resellable','damaged') NOT NULL,
  PRIMARY KEY (order_id, return_seq, item_seq),
  KEY idx_return_items_item (order_id, item_seq),
  CONSTRAINT fk_return_items_return FOREIGN KEY (order_id, return_seq) REFERENCES order_returns (order_id, return_seq),
  CONSTRAINT fk_return_items_item FOREIGN KEY (order_id, item_seq) REFERENCES order_items (order_id, item_seq),
  CONSTRAINT chk_return_items_quantity CHECK (quantity > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_reviews (
  order_id     BIGINT UNSIGNED   NOT NULL,
  item_seq     SMALLINT UNSIGNED NOT NULL,
  rating       TINYINT UNSIGNED  NOT NULL,
  title        VARCHAR(120)      NOT NULL,
  comment      VARCHAR(500)      NULL,
  created_at   DATETIME          NOT NULL,
  answered_at  DATETIME          NULL,
  PRIMARY KEY (order_id, item_seq),
  KEY idx_product_reviews_rating (rating),
  KEY idx_product_reviews_created (created_at),
  CONSTRAINT fk_product_reviews_item FOREIGN KEY (order_id, item_seq) REFERENCES order_items (order_id, item_seq),
  CONSTRAINT chk_product_reviews_rating CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT chk_product_reviews_answer CHECK (answered_at IS NULL OR answered_at >= created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS promotion_redemptions (
  order_id         BIGINT UNSIGNED NOT NULL,
  promotion_id     INT UNSIGNED    NOT NULL,
  discount_amount  DECIMAL(12,2)   NOT NULL,
  redeemed_at      DATETIME        NOT NULL,
  PRIMARY KEY (order_id),
  KEY idx_promotion_redemptions_promotion (promotion_id, redeemed_at),
  CONSTRAINT fk_promotion_redemptions_order FOREIGN KEY (order_id) REFERENCES orders (order_id),
  CONSTRAINT fk_promotion_redemptions_promotion FOREIGN KEY (promotion_id) REFERENCES promotions (promotion_id),
  CONSTRAINT chk_promotion_redemptions_amount CHECK (discount_amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shopping_carts (
  cart_id             BIGINT UNSIGNED NOT NULL,
  customer_id         BIGINT UNSIGNED NOT NULL,
  status              ENUM('active','abandoned','converted') NOT NULL,
  converted_order_id  BIGINT UNSIGNED NULL,
  created_at          DATETIME        NOT NULL,
  updated_at          DATETIME        NOT NULL,
  PRIMARY KEY (cart_id),
  UNIQUE KEY uq_shopping_carts_order (converted_order_id),
  KEY idx_shopping_carts_customer (customer_id),
  KEY idx_shopping_carts_status_updated (status, updated_at),
  CONSTRAINT fk_shopping_carts_customer FOREIGN KEY (customer_id) REFERENCES customers (customer_id),
  CONSTRAINT fk_shopping_carts_order FOREIGN KEY (converted_order_id) REFERENCES orders (order_id),
  CONSTRAINT chk_shopping_carts_conversion CHECK (
    (status = 'converted' AND converted_order_id IS NOT NULL) OR (status <> 'converted' AND converted_order_id IS NULL)),
  CONSTRAINT chk_shopping_carts_dates CHECK (updated_at >= created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shopping_cart_items (
  cart_id     BIGINT UNSIGNED   NOT NULL,
  product_id  BIGINT UNSIGNED   NOT NULL,
  quantity    SMALLINT UNSIGNED NOT NULL,
  unit_price  DECIMAL(12,2)     NOT NULL,
  added_at    DATETIME          NOT NULL,
  PRIMARY KEY (cart_id, product_id),
  KEY idx_shopping_cart_items_product (product_id),
  CONSTRAINT fk_shopping_cart_items_cart FOREIGN KEY (cart_id) REFERENCES shopping_carts (cart_id),
  CONSTRAINT fk_shopping_cart_items_product FOREIGN KEY (product_id) REFERENCES products (product_id),
  CONSTRAINT chk_shopping_cart_items_values CHECK (quantity > 0 AND unit_price > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_movements (
  movement_id    BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  product_id     BIGINT UNSIGNED   NOT NULL,
  warehouse_id   SMALLINT UNSIGNED NOT NULL,
  movement_type  ENUM('opening','receipt','sale','return','adjustment','damage') NOT NULL,
  quantity       INT               NOT NULL,
  order_id       BIGINT UNSIGNED   NULL,
  moved_at       DATETIME          NOT NULL,
  note           VARCHAR(120)      NULL,
  PRIMARY KEY (movement_id),
  KEY idx_inventory_movements_stock (product_id, warehouse_id, moved_at),
  KEY idx_inventory_movements_moved (moved_at),
  KEY idx_inventory_movements_order (order_id),
  CONSTRAINT fk_inventory_movements_inventory FOREIGN KEY (product_id, warehouse_id) REFERENCES inventory (product_id, warehouse_id),
  CONSTRAINT fk_inventory_movements_order FOREIGN KEY (order_id) REFERENCES orders (order_id),
  CONSTRAINT chk_inventory_movements_sign CHECK (
    (movement_type IN ('opening','receipt','return') AND quantity > 0)
    OR (movement_type IN ('sale','damage') AND quantity < 0)
    OR (movement_type = 'adjustment' AND quantity <> 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
