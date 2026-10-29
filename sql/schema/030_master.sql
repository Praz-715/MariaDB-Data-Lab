-- Master data: customers, sellers, catalogue, promotions and stock locations.

CREATE TABLE IF NOT EXISTS customers (
  customer_id       BIGINT UNSIGNED  NOT NULL,
  customer_code     CHAR(12)         NOT NULL,
  first_name        VARCHAR(60)      NOT NULL,
  last_name         VARCHAR(80)      NOT NULL,
  email             VARCHAR(160)     NOT NULL,
  phone             VARCHAR(20)      NOT NULL,
  birth_date        DATE             NULL,
  segment_id        TINYINT UNSIGNED NOT NULL,
  status            ENUM('active','inactive') NOT NULL DEFAULT 'active',
  marketing_opt_in  TINYINT(1)       NOT NULL DEFAULT 0,
  created_at        DATETIME         NOT NULL,
  PRIMARY KEY (customer_id),
  UNIQUE KEY uq_customers_code (customer_code),
  UNIQUE KEY uq_customers_email (email),
  KEY idx_customers_segment (segment_id),
  KEY idx_customers_created (created_at),
  CONSTRAINT fk_customers_segment FOREIGN KEY (segment_id) REFERENCES customer_segments (segment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customer_addresses (
  customer_id    BIGINT UNSIGNED  NOT NULL,
  address_seq    TINYINT UNSIGNED NOT NULL,
  address_type   ENUM('shipping','billing','both') NOT NULL,
  street         VARCHAR(120)     NOT NULL,
  street_number  VARCHAR(10)      NOT NULL,
  complement     VARCHAR(60)      NULL,
  district       VARCHAR(80)      NOT NULL,
  zip_code       CHAR(9)          NOT NULL,
  location_id    INT UNSIGNED     NOT NULL,
  is_default     TINYINT(1)       NOT NULL DEFAULT 0,
  created_at     DATETIME         NOT NULL,
  PRIMARY KEY (customer_id, address_seq),
  KEY idx_customer_addresses_location (location_id),
  CONSTRAINT fk_customer_addresses_customer FOREIGN KEY (customer_id) REFERENCES customers (customer_id),
  CONSTRAINT fk_customer_addresses_location FOREIGN KEY (location_id) REFERENCES geographic_locations (location_id),
  CONSTRAINT chk_customer_addresses_zip CHECK (zip_code REGEXP '^[0-9]{5}-[0-9]{3}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sellers (
  seller_id          INT UNSIGNED      NOT NULL,
  seller_code        CHAR(12)          NOT NULL,
  legal_name         VARCHAR(160)      NOT NULL,
  display_name       VARCHAR(100)      NOT NULL,
  email              VARCHAR(160)      NOT NULL,
  phone              VARCHAR(20)       NOT NULL,
  rating             DECIMAL(3,2)      NOT NULL,
  status             ENUM('active','suspended','closed') NOT NULL DEFAULT 'active',
  home_warehouse_id  SMALLINT UNSIGNED NOT NULL,
  created_at         DATETIME          NOT NULL,
  PRIMARY KEY (seller_id),
  UNIQUE KEY uq_sellers_code (seller_code),
  UNIQUE KEY uq_sellers_email (email),
  KEY idx_sellers_warehouse (home_warehouse_id),
  CONSTRAINT fk_sellers_warehouse FOREIGN KEY (home_warehouse_id) REFERENCES warehouses (warehouse_id),
  CONSTRAINT chk_sellers_rating CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS seller_addresses (
  seller_id      INT UNSIGNED     NOT NULL,
  address_seq    TINYINT UNSIGNED NOT NULL,
  address_type   ENUM('registered','pickup') NOT NULL,
  street         VARCHAR(120)     NOT NULL,
  street_number  VARCHAR(10)      NOT NULL,
  district       VARCHAR(80)      NOT NULL,
  zip_code       CHAR(9)          NOT NULL,
  location_id    INT UNSIGNED     NOT NULL,
  PRIMARY KEY (seller_id, address_seq),
  KEY idx_seller_addresses_location (location_id),
  CONSTRAINT fk_seller_addresses_seller FOREIGN KEY (seller_id) REFERENCES sellers (seller_id),
  CONSTRAINT fk_seller_addresses_location FOREIGN KEY (location_id) REFERENCES geographic_locations (location_id),
  CONSTRAINT chk_seller_addresses_zip CHECK (zip_code REGEXP '^[0-9]{5}-[0-9]{3}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
  product_id    BIGINT UNSIGNED NOT NULL,
  sku           VARCHAR(24)     NOT NULL,
  seller_id     INT UNSIGNED    NOT NULL,
  category_id   INT UNSIGNED    NOT NULL,
  product_name  VARCHAR(160)    NOT NULL,
  list_price    DECIMAL(12,2)   NOT NULL,
  cost_price    DECIMAL(12,2)   NOT NULL,
  weight_g      INT UNSIGNED    NOT NULL,
  length_cm     SMALLINT UNSIGNED NOT NULL,
  height_cm     SMALLINT UNSIGNED NOT NULL,
  width_cm      SMALLINT UNSIGNED NOT NULL,
  status        ENUM('active','discontinued') NOT NULL DEFAULT 'active',
  created_at    DATETIME        NOT NULL,
  PRIMARY KEY (product_id),
  UNIQUE KEY uq_products_sku (sku),
  KEY idx_products_category (category_id),
  KEY idx_products_seller (seller_id),
  CONSTRAINT fk_products_seller FOREIGN KEY (seller_id) REFERENCES sellers (seller_id),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES product_categories (category_id),
  CONSTRAINT chk_products_prices CHECK (list_price > 0 AND cost_price > 0 AND cost_price < list_price),
  CONSTRAINT chk_products_dimensions CHECK (weight_g > 0 AND length_cm > 0 AND height_cm > 0 AND width_cm > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_attributes (
  product_id       BIGINT UNSIGNED NOT NULL,
  attribute_name   VARCHAR(40)     NOT NULL,
  attribute_value  VARCHAR(100)    NOT NULL,
  PRIMARY KEY (product_id, attribute_name),
  KEY idx_product_attributes_name_value (attribute_name, attribute_value),
  CONSTRAINT fk_product_attributes_product FOREIGN KEY (product_id) REFERENCES products (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS promotions (
  promotion_id      INT UNSIGNED  NOT NULL,
  promotion_code    VARCHAR(24)   NOT NULL,
  promotion_name    VARCHAR(100)  NOT NULL,
  discount_type     ENUM('percent','fixed') NOT NULL,
  discount_value    DECIMAL(10,2) NOT NULL,
  max_discount      DECIMAL(10,2) NULL,
  min_order_amount  DECIMAL(10,2) NOT NULL DEFAULT 0,
  starts_at         DATETIME      NOT NULL,
  ends_at           DATETIME      NOT NULL,
  PRIMARY KEY (promotion_id),
  UNIQUE KEY uq_promotions_code (promotion_code),
  KEY idx_promotions_window (starts_at, ends_at),
  CONSTRAINT chk_promotions_window CHECK (ends_at > starts_at),
  CONSTRAINT chk_promotions_value CHECK (discount_value > 0 AND (discount_type <> 'percent' OR discount_value <= 90))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory (
  product_id        BIGINT UNSIGNED   NOT NULL,
  warehouse_id      SMALLINT UNSIGNED NOT NULL,
  quantity_on_hand  INT               NOT NULL DEFAULT 0,
  reorder_level     INT UNSIGNED      NOT NULL,
  updated_at        DATETIME          NOT NULL,
  PRIMARY KEY (product_id, warehouse_id),
  KEY idx_inventory_warehouse (warehouse_id),
  CONSTRAINT fk_inventory_product FOREIGN KEY (product_id) REFERENCES products (product_id),
  CONSTRAINT fk_inventory_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses (warehouse_id),
  CONSTRAINT chk_inventory_quantity CHECK (quantity_on_hand >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
