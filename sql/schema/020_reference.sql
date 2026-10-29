-- Reference data: small, slowly-changing lookup tables.

CREATE TABLE IF NOT EXISTS currencies (
  currency_code   CHAR(3)          NOT NULL,
  currency_name   VARCHAR(64)      NOT NULL,
  symbol          VARCHAR(8)       NOT NULL,
  decimal_places  TINYINT UNSIGNED NOT NULL DEFAULT 2,
  rate_to_brl     DECIMAL(18,8)    NOT NULL,
  PRIMARY KEY (currency_code),
  CONSTRAINT chk_currencies_rate CHECK (rate_to_brl > 0),
  CONSTRAINT chk_currencies_decimals CHECK (decimal_places <= 4)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS geographic_locations (
  location_id  INT UNSIGNED  NOT NULL,
  zip_prefix   CHAR(5)       NOT NULL,
  city         VARCHAR(80)   NOT NULL,
  state_code   CHAR(2)       NOT NULL,
  state_name   VARCHAR(40)   NOT NULL,
  region       ENUM('North','Northeast','Central-West','Southeast','South') NOT NULL,
  latitude     DECIMAL(9,6)  NOT NULL,
  longitude    DECIMAL(9,6)  NOT NULL,
  PRIMARY KEY (location_id),
  UNIQUE KEY uq_geographic_locations_zip (zip_prefix),
  KEY idx_geographic_locations_state_city (state_code, city),
  KEY idx_geographic_locations_region (region),
  CONSTRAINT chk_geographic_locations_lat CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT chk_geographic_locations_lng CHECK (longitude BETWEEN -180 AND 180)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customer_segments (
  segment_id    TINYINT UNSIGNED NOT NULL,
  segment_code  VARCHAR(20)      NOT NULL,
  segment_name  VARCHAR(60)      NOT NULL,
  description   VARCHAR(255)     NOT NULL,
  PRIMARY KEY (segment_id),
  UNIQUE KEY uq_customer_segments_code (segment_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shipping_carriers (
  carrier_id        SMALLINT UNSIGNED NOT NULL,
  carrier_code      VARCHAR(20)       NOT NULL,
  carrier_name      VARCHAR(80)       NOT NULL,
  service_level     ENUM('economy','standard','express','same_day') NOT NULL,
  base_rate         DECIMAL(10,2)     NOT NULL,
  per_kg_rate       DECIMAL(10,2)     NOT NULL,
  avg_transit_days  DECIMAL(5,2)      NOT NULL,
  is_active         TINYINT(1)        NOT NULL DEFAULT 1,
  PRIMARY KEY (carrier_id),
  UNIQUE KEY uq_shipping_carriers_code (carrier_code),
  CONSTRAINT chk_shipping_carriers_rates CHECK (base_rate >= 0 AND per_kg_rate >= 0 AND avg_transit_days > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS warehouses (
  warehouse_id    SMALLINT UNSIGNED NOT NULL,
  warehouse_code  VARCHAR(20)       NOT NULL,
  warehouse_name  VARCHAR(100)      NOT NULL,
  location_id     INT UNSIGNED      NOT NULL,
  capacity_units  INT UNSIGNED      NOT NULL,
  opened_at       DATE              NOT NULL,
  PRIMARY KEY (warehouse_id),
  UNIQUE KEY uq_warehouses_code (warehouse_code),
  KEY idx_warehouses_location (location_id),
  CONSTRAINT fk_warehouses_location FOREIGN KEY (location_id) REFERENCES geographic_locations (location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_categories (
  category_id         INT UNSIGNED     NOT NULL,
  parent_category_id  INT UNSIGNED     NULL,
  category_code       VARCHAR(80)      NOT NULL,
  category_name       VARCHAR(100)     NOT NULL,
  depth               TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (category_id),
  UNIQUE KEY uq_product_categories_code (category_code),
  KEY idx_product_categories_parent (parent_category_id),
  CONSTRAINT fk_product_categories_parent FOREIGN KEY (parent_category_id) REFERENCES product_categories (category_id),
  CONSTRAINT chk_product_categories_depth CHECK ((parent_category_id IS NULL AND depth = 0) OR (parent_category_id IS NOT NULL AND depth > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
