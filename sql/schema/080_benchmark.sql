-- Schema version 4: scratch table for write benchmarks. Benchmarks never write to
-- the business tables; this table is truncated before and after each write run.

CREATE TABLE IF NOT EXISTS bench_events (
  event_id     BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  run_id       CHAR(36)         NOT NULL,
  worker       SMALLINT UNSIGNED NOT NULL,
  seq          INT UNSIGNED     NOT NULL,
  customer_id  BIGINT UNSIGNED  NOT NULL,
  amount       DECIMAL(12,2)    NOT NULL,
  payload      VARCHAR(200)     NOT NULL,
  created_at   DATETIME(3)      NOT NULL,
  updated_at   DATETIME(3)      NULL,
  PRIMARY KEY (event_id),
  KEY idx_bench_events_run_worker (run_id, worker, seq),
  KEY idx_bench_events_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Performance Lab scratch table; emptied before and after write benchmarks';
