-- Analytical summary tables, refreshed by the generator's final phase (and later by
-- scheduled events). Dashboards read these instead of scanning the fact tables.

CREATE TABLE IF NOT EXISTS daily_sales_summary (
  sales_date         DATE            NOT NULL,
  orders_count       INT UNSIGNED    NOT NULL,
  delivered_orders   INT UNSIGNED    NOT NULL,
  canceled_orders    INT UNSIGNED    NOT NULL,
  items_sold         INT UNSIGNED    NOT NULL,
  gross_merchandise  DECIMAL(16,2)   NOT NULL,
  shipping_revenue   DECIMAL(16,2)   NOT NULL,
  discounts          DECIMAL(16,2)   NOT NULL,
  net_revenue        DECIMAL(16,2)   NOT NULL,
  unique_customers   INT UNSIGNED    NOT NULL,
  refreshed_at       DATETIME        NOT NULL,
  PRIMARY KEY (sales_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='One row per purchase date; revenue excludes canceled and unavailable orders';

CREATE TABLE IF NOT EXISTS monthly_sales_summary (
  month_start   DATE          NOT NULL,
  category_id   INT UNSIGNED  NOT NULL,
  orders_count  INT UNSIGNED  NOT NULL,
  items_sold    INT UNSIGNED  NOT NULL,
  revenue       DECIMAL(16,2) NOT NULL,
  refreshed_at  DATETIME      NOT NULL,
  PRIMARY KEY (month_start, category_id),
  KEY idx_monthly_sales_summary_category (category_id, month_start),
  CONSTRAINT fk_monthly_sales_summary_category FOREIGN KEY (category_id) REFERENCES product_categories (category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Item revenue by purchase month and leaf category, excluding canceled and unavailable orders';

CREATE TABLE IF NOT EXISTS data_generation_audit (
  audit_id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id         CHAR(36)        NOT NULL,
  table_name     VARCHAR(64)     NOT NULL,
  rows_inserted  BIGINT UNSIGNED NOT NULL,
  seed           INT UNSIGNED    NOT NULL,
  generator_version SMALLINT UNSIGNED NOT NULL,
  recorded_at    DATETIME        NOT NULL,
  PRIMARY KEY (audit_id),
  UNIQUE KEY uq_data_generation_audit_job_table (job_id, table_name),
  KEY idx_data_generation_audit_recorded (recorded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Rows inserted per table per generation job; kept across data cleanup';
