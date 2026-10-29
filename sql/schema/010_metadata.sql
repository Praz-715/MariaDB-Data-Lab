-- MariaDB Data Lab: metadata tables used by the application itself.
-- Applied by the Schema Designer into the configured lab schema only.

CREATE TABLE IF NOT EXISTS lab_schema_info (
  info_key      VARCHAR(64)  NOT NULL,
  info_value    VARCHAR(255) NOT NULL,
  updated_at    DATETIME     NOT NULL,
  PRIMARY KEY (info_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Ownership marker: identifies this schema as managed by MariaDB Data Lab';

CREATE TABLE IF NOT EXISTS lab_jobs (
  job_id          CHAR(36)        NOT NULL,
  job_type        ENUM('generation','validation','import','benchmark','cleanup') NOT NULL,
  status          ENUM('queued','running','paused','completed','failed','canceled','interrupted') NOT NULL,
  config          JSON            NOT NULL,
  progress        JSON            NULL,
  result          JSON            NULL,
  error_log       JSON            NULL,
  rows_processed  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_estimated  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at      DATETIME(3)     NOT NULL,
  started_at      DATETIME(3)     NULL,
  finished_at     DATETIME(3)     NULL,
  updated_at      DATETIME(3)     NOT NULL,
  PRIMARY KEY (job_id),
  KEY idx_lab_jobs_type_created (job_type, created_at),
  KEY idx_lab_jobs_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Every import, generation, validation and benchmark job with its configuration snapshot';

CREATE TABLE IF NOT EXISTS lab_job_batches (
  job_id         CHAR(36)          NOT NULL,
  phase          VARCHAR(32)       NOT NULL,
  unit_no        INT UNSIGNED      NOT NULL,
  status         ENUM('done','failed') NOT NULL,
  rows_inserted  INT UNSIGNED      NOT NULL DEFAULT 0,
  table_counts   JSON              NULL,
  attempts       TINYINT UNSIGNED  NOT NULL DEFAULT 1,
  last_error     VARCHAR(1000)     NULL,
  updated_at     DATETIME(3)       NOT NULL,
  PRIMARY KEY (job_id, phase, unit_no),
  CONSTRAINT fk_lab_job_batches_job FOREIGN KEY (job_id) REFERENCES lab_jobs (job_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Commit ledger: a unit is marked done in the same transaction as its data, which makes resume exactly-once';
