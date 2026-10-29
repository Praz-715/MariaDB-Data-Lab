-- Staging area for public dataset imports (Phase 2). Raw CSV rows are validated,
-- typed and loaded here first; a separate transform step maps them into the lab
-- tables. Keys are indexed for the cross-file joins of the transform, but no
-- foreign keys are declared: staging must accept files in any order.

CREATE TABLE IF NOT EXISTS stg_olist_category_translation (
  src_row                INT UNSIGNED NOT NULL,
  category_name          VARCHAR(80)  NOT NULL,
  category_name_english  VARCHAR(80)  NOT NULL,
  PRIMARY KEY (src_row),
  KEY idx_stg_cat_name (category_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stg_olist_geolocation (
  src_row     INT UNSIGNED NOT NULL,
  zip_prefix  CHAR(5)      NOT NULL,
  lat         DOUBLE       NOT NULL,
  lng         DOUBLE       NOT NULL,
  city        VARCHAR(80)  NOT NULL,
  state       CHAR(2)      NOT NULL,
  PRIMARY KEY (src_row),
  KEY idx_stg_geo_zip (zip_prefix)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stg_olist_customers (
  src_row             INT UNSIGNED NOT NULL,
  customer_id         CHAR(32)     NOT NULL,
  customer_unique_id  CHAR(32)     NOT NULL,
  zip_prefix          CHAR(5)      NOT NULL,
  city                VARCHAR(80)  NOT NULL,
  state               CHAR(2)      NOT NULL,
  PRIMARY KEY (src_row),
  KEY idx_stg_cust_id (customer_id),
  KEY idx_stg_cust_unique (customer_unique_id, zip_prefix)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stg_olist_sellers (
  src_row     INT UNSIGNED NOT NULL,
  seller_id   CHAR(32)     NOT NULL,
  zip_prefix  CHAR(5)      NOT NULL,
  city        VARCHAR(80)  NOT NULL,
  state       CHAR(2)      NOT NULL,
  PRIMARY KEY (src_row),
  KEY idx_stg_seller_id (seller_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stg_olist_products (
  src_row             INT UNSIGNED NOT NULL,
  product_id          CHAR(32)     NOT NULL,
  category_name       VARCHAR(80)  NULL,
  name_length         SMALLINT UNSIGNED NULL,
  description_length  INT UNSIGNED NULL,
  photos_qty          SMALLINT UNSIGNED NULL,
  weight_g            INT UNSIGNED NULL,
  length_cm           SMALLINT UNSIGNED NULL,
  height_cm           SMALLINT UNSIGNED NULL,
  width_cm            SMALLINT UNSIGNED NULL,
  PRIMARY KEY (src_row),
  KEY idx_stg_product_id (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stg_olist_orders (
  src_row       INT UNSIGNED NOT NULL,
  order_id      CHAR(32)     NOT NULL,
  customer_id   CHAR(32)     NOT NULL,
  status        VARCHAR(20)  NOT NULL,
  purchased_at  DATETIME     NOT NULL,
  approved_at   DATETIME     NULL,
  carrier_at    DATETIME     NULL,
  delivered_at  DATETIME     NULL,
  estimated_at  DATETIME     NULL,
  PRIMARY KEY (src_row),
  KEY idx_stg_order_id (order_id),
  KEY idx_stg_order_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stg_olist_order_items (
  src_row            INT UNSIGNED      NOT NULL,
  order_id           CHAR(32)          NOT NULL,
  item_seq           SMALLINT UNSIGNED NOT NULL,
  product_id         CHAR(32)          NOT NULL,
  seller_id          CHAR(32)          NOT NULL,
  shipping_limit_at  DATETIME          NULL,
  price              DECIMAL(12,2)     NOT NULL,
  freight            DECIMAL(12,2)     NOT NULL,
  PRIMARY KEY (src_row),
  KEY idx_stg_items_order (order_id),
  KEY idx_stg_items_listing (product_id, seller_id),
  KEY idx_stg_items_seller (seller_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stg_olist_payments (
  src_row       INT UNSIGNED      NOT NULL,
  order_id      CHAR(32)          NOT NULL,
  payment_seq   SMALLINT UNSIGNED NOT NULL,
  payment_type  VARCHAR(20)       NOT NULL,
  installments  SMALLINT UNSIGNED NOT NULL,
  amount        DECIMAL(12,2)     NOT NULL,
  PRIMARY KEY (src_row),
  KEY idx_stg_pay_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stg_olist_reviews (
  src_row      INT UNSIGNED     NOT NULL,
  review_id    CHAR(32)         NOT NULL,
  order_id     CHAR(32)         NOT NULL,
  score        TINYINT UNSIGNED NOT NULL,
  title        VARCHAR(255)     NULL,
  message      TEXT             NULL,
  created_at   DATETIME         NULL,
  answered_at  DATETIME         NULL,
  PRIMARY KEY (src_row),
  KEY idx_stg_review_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stg_import_rejects (
  job_id       CHAR(36)     NOT NULL,
  file_key     VARCHAR(40)  NOT NULL,
  src_row      INT UNSIGNED NOT NULL,
  reason       VARCHAR(200) NOT NULL,
  raw_excerpt  VARCHAR(500) NOT NULL,
  PRIMARY KEY (job_id, file_key, src_row)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Sample of rejected CSV records (capped per file); full counts are in the job result';

CREATE TABLE IF NOT EXISTS map_olist_ids (
  entity      VARCHAR(20)     NOT NULL,
  source_key  VARCHAR(80)     NOT NULL,
  target_id   BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (entity, source_key),
  UNIQUE KEY uq_map_olist_target (entity, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Olist hex ids (and product x seller listings) to lab BIGINT ids; emptied with generated data';
