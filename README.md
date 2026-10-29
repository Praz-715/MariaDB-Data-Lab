# MariaDB Data Lab

A framework-free web application that generates realistic, relationally consistent e-commerce data in MariaDB,
validates it against business rules, imports a public reference dataset, benchmarks and diagnoses the server.

- **Backend:** Node.js (native `http`), official [`mariadb`](https://www.npmjs.com/package/mariadb) connector. No other runtime dependencies.
- **Frontend:** vanilla HTML, CSS and ES modules. No framework, no build step.
- **Database:** MariaDB 10.6+ with InnoDB (developed and tested on MariaDB 11.4 LTS).

## Status

The project was built in phases. **All five phases are complete and tested**: every page in the sidebar is implemented
and reads real data.

| Phase | Scope | Status |
|---|---|---|
| 1 | Connection manager, 30-table schema with constraints, deterministic generator (Small to XL presets), bulk loading with resumable jobs, business-rule validation, job history, overview KPIs | **Done** |
| 2 | Olist CSV import (upload, streaming scan, mapping preview, validation, staging, transform with repair report), Server-Sent Events progress, calibrated scaling, 10M-row run | **Done** |
| 3 | Table Explorer (keyset pagination, filters, relationships), database object generator (views, functions, procedures, triggers, events, query-driven indexes), partitioning lab, Visual Analytics (13 charts) | **Done** |
| 4 | Performance Lab (13 scenarios, warm-up, latency percentiles, environment snapshots, run comparison), read-only SQL diagnostics | **Done** |
| 5 | Security review and hardening ([docs/SECURITY.md](docs/SECURITY.md)), HTTP-level tests, XL-scale (49.5M rows) run, validation tuning for large datasets | **Done** |

**Upgrading:** the schema version is now 4 (version 2 added import staging tables, version 3 the `objects` job type,
version 4 the `bench_events` scratch table). Re-apply the schema on the Schema Designer page. It only adds tables or widens an enum, and existing data
is untouched. Also grant `EXECUTE` to the runtime account (see [docs/PERMISSIONS.md](docs/PERMISSIONS.md)).

## Quick start

### 1. Prerequisites

- Node.js 20.12 or newer
- A MariaDB server you are allowed to load test data into. To try it locally with Docker:

  ```sh
  docker run -d --name datalab-mariadb -p 127.0.0.1:3307:3306 \
    -e MARIADB_ROOT_PASSWORD=change-me-root mariadb:11.4 --innodb-buffer-pool-size=512M
  ```

### 2. Database accounts

Create a runtime account (DML) and an admin account (DDL) as described in
[docs/PERMISSIONS.md](docs/PERMISSIONS.md). With the Docker container above:

```sh
docker exec -i datalab-mariadb mariadb -uroot -pchange-me-root <<'SQL'
CREATE USER 'datalab_admin'@'%' IDENTIFIED BY 'admin-pass';
GRANT CREATE, ALTER, DROP, INDEX, REFERENCES, SELECT, INSERT, UPDATE, DELETE,
      CREATE VIEW, SHOW VIEW, TRIGGER, CREATE ROUTINE, ALTER ROUTINE, EVENT, EXECUTE ON `datalab`.* TO 'datalab_admin'@'%';
CREATE USER 'datalab_app'@'%' IDENTIFIED BY 'app-pass';
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON `datalab`.* TO 'datalab_app'@'%';
SQL
```

### 3. Configure and run

```sh
npm install
cp .env.example .env      # then edit DB_* values (e.g. DB_PORT=3307 for the container above)
npm start                 # http://127.0.0.1:8080
```

### 4. First run in the browser

1. **Connections:** the active profile is tested automatically. Check the version, grants and warnings.
2. **Schema Designer:** tick "create database", type the schema name to authorize, apply.
   This creates 44 tables (30 business, 3 metadata, 11 import staging), 42 foreign keys, 43 CHECK constraints and
   121 indexes. A dedicated schema is best. An existing schema that already holds unrelated tables can be shared
   after an extra confirmation; see [Installing into an existing schema](#installing-into-an-existing-schema).
3. **Data Generator:** pick the *Small* preset (about 100K rows, a few seconds) and start it. Progress is streamed
   from the backend with Server-Sent Events: committed units per phase, rows/s, ETA, errors.
4. **Run validation:** 27 business rules run as SQL against the generated data, plus a realism profile.
5. **Overview:** KPIs read from MariaDB.
6. Optional: **Dataset Sources** and **Import Manager** load the real Olist dataset. See [Olist import](#olist-import).

## Configuration

All configuration is server-side in `.env` (see [.env.example](.env.example)):

| Variable | Default | Meaning |
|---|---|---|
| `APP_HOST`, `APP_PORT` | `127.0.0.1`, `8080` | Listen address. Keep loopback unless you set a token. |
| `APP_ACCESS_TOKEN` | empty | Bearer token (16+ characters) required on every `/api` request (entered on the Settings page). Mandatory on a non-loopback bind. |
| `APP_ALLOWED_HOSTS` | empty | Extra `Host` names accepted, comma-separated (loopback names are always accepted on a loopback bind). |
| `ALLOW_CONNECTION_OVERRIDE` | `true` on loopback, `false` otherwise | Allows the Connections page to replace the profile in memory. |
| `DB_OVERRIDE_HOST_ALLOWLIST` | empty (any) | Hosts the Connections page may switch to. |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` | | Runtime account. |
| `DB_NAME` | `datalab` | Dedicated lab schema. System schemas are rejected. |
| `DB_ADMIN_USER`, `DB_ADMIN_PASSWORD` | empty | DDL and cleanup account. Falls back to the runtime account. |
| `DB_SSL` | `disabled` | `disabled`, `verify` (with `DB_SSL_CA`), or `skip-verify`. |
| `DB_POOL_SIZE`, `DB_CONNECT_TIMEOUT_MS` | `10`, `10000` | Pool limit and connect timeout. |
| `GEN_MAX_WORKERS` | `8` | Upper bound for concurrent generation workers. |
| `GEN_MAX_TOTAL_ROWS` | `60000000` | Hard cap on a single generation run. |
| `GEN_CONFIRM_ROWS_THRESHOLD` | `1000000` | Runs above this need typed confirmation. |
| `VALIDATION_STATEMENT_TIMEOUT_SEC` | `300` | `max_statement_time` for each validation query. |
| `DATASET_DIR` | `datasets/raw` | Where the Olist CSV files are read from and uploaded to. |
| `IMPORT_MAX_UPLOAD_MB` | `1024` | Size limit for one uploaded CSV file. |
| `BENCH_MAX_CONCURRENCY`, `BENCH_MAX_DURATION_SEC` | `32`, `600` | Hard limits for one benchmark run. |
| `BENCH_HEAVY_CONCURRENCY`, `BENCH_HEAVY_DURATION_SEC`, `BENCH_HEAVY_ITERATIONS` | `8`, `60`, `100000` | Above these (or above 1M rows written) a run needs typed confirmation. |

## How generation works

**Business model.** An Olist-like Brazilian marketplace: customers and sellers across 55 cities in all 27 states
(145 postal-code prefixes within real CEP ranges), 11 category groups with up to 400 leaf categories, products
with category-specific lognormal prices and weights, promotions including Black Friday campaigns, and fictional
carriers and fulfilment centres. See [docs/ERD.md](docs/ERD.md).

**Realistic behaviour, not uniform noise:**

- Seasonality: business growth over the window, monthly factors, weekday pattern (Mondays highest), hour-of-day
  curve, Black Friday, Christmas run-up, Mother's Day.
- Popularity: power-law product and customer popularity, so there are bestsellers and repeat buyers
  (about 30% of buyers repeat in the Medium preset), and most order lines come from the same seller.
- Order lifecycle: payment method drives approval delay (boleto takes about a day, and about 8% are never paid);
  card declines and retries; post-approval cancellations and unavailable items; seller-specific handling time;
  carrier and distance-specific transit; about 7% delayed deliveries and failed delivery attempts. Orders near the
  end of the window are still `created`, `approved` or `shipped`.
- Consequences: late deliveries double the return rate and drop ratings (about 4.05 on-time vs 2.56 late);
  returns create refunds and restock movements; split payments use vouchers.
- Money is computed in integer cents, so `total = subtotal + shipping - discount` and the sum of payments match
  exactly.

**Determinism.** Every entity is a pure function of `(seed, entity id)`; cross-references recompute the
referenced entity instead of reading the database. The same configuration and seed produce the same dataset
regardless of worker count or resume points. The integration tests verify this with per-table content hashes.
`inventory_movements.movement_id` (auto-increment) is the only value that may differ between runs.

**Bulk loading.** Work runs in foreign-key order through nine phases: reference data, customers, sellers, products,
orders (with items, shipments, tracking, payments, returns, reviews, sale movements), carts, stock movements,
inventory balances, summary tables. Each phase is split into *units* of `commitInterval` entities, inserted with
the connector's bulk `batch()` in chunks of `batchSize`, one transaction per unit, with `workers` units in
parallel. Foreign-key checks stay on.

**Exactly-once resume.** Each unit writes a row to `lab_job_batches` **in the same transaction** as its data. A
crash, cancel or failure therefore never leaves half a unit behind, and resume skips exactly the committed units.
Transient errors (deadlock, lock wait timeout, AUTO-INC conflict, lost connection) are retried up to 4 times with
backoff. Other errors mark the unit `failed`; after 5 failed units the phase stops, and **Resume** retries only
what is missing. A new run refuses to start while data tables contain rows, which prevents duplicates and mixed
datasets.

**Presets** (estimates are computed by running the generator on sampled ids):

| Preset | Customers | Orders | Products | Estimated rows | Estimated size |
|---|---|---|---|---|---|
| Small | 6,000 | 4,700 | 1,500 | ~99K | ~19 MiB |
| Medium | 62,000 | 48,000 | 15,000 | ~994K | ~192 MiB |
| Large | 640,000 | 495,000 | 125,000 | ~10.0M | ~1.9 GiB |
| XL | 3,200,000 | 2,480,000 | 520,000 | ~49.8M | ~9.4 GiB |

Measured on a laptop with MariaDB 11.4 in Docker (512 MiB buffer pool, 4 workers):

| Run | Rows | Time | Throughput | Validation (27 rules) |
|---|---|---|---|---|
| Small | 96,863 | ~5 s | ~15–20K rows/s | < 1 s |
| Medium | 988,810 | 13 s | ~76K rows/s | 2.7 s |
| Large | 10,005,802 | 120 s | ~83K rows/s average, >100K rows/s peak | 116 s |
| XL | 49,546,166 | ~47 min active | ~17K rows/s average; ~75K rows/s for the first ~15M rows, then 15–25K rows/s | 14.5 min, all 27 rules pass |

Your throughput depends on hardware, storage, buffer pool and server configuration; these numbers describe this one
environment only. The XL run completed with 0 failed units; the laptop slept for 16 hours in the middle of the
orders phase, and the job simply continued on wake (the sleep is excluded from "active" time).

**Large-scale notes (from the XL run).** While the working set fits in the InnoDB buffer pool, generation is
CPU-bound at 70–80K rows/s. Here, past roughly 15M rows (about 2 GiB of data and indexes against a 512 MiB buffer
pool), inserts into secondary indexes started to touch pages that were no longer cached, and throughput fell to
15–25K rows/s for the rest of the orders phase. For XL runs:

- Give InnoDB a buffer pool of several GiB (the XL dataset is ~7.3 GiB of data and indexes per InnoDB statistics).
- Keep `workers` at 4–8; more workers add lock and I/O contention without raising throughput once I/O-bound.
- Remove optional catalog indexes and triggers before a large run and re-apply them afterwards (done for this run;
  each extra index is another random-write target).
- On a disposable test server only, `innodb_flush_log_at_trx_commit=2` reduces log flush cost. The app never
  changes server settings itself.

Payments, shipments, reviews and returns are derived from orders by the business rules, so they are controlled by
rates (review rate, return rate, split-payment rate, promotion rate) rather than independent counts. The
estimate panel shows the resulting counts before you start.

## Table Explorer

- Tables grouped by layer, with InnoDB-estimated row counts labelled as estimates and an **Exact count** button
  (`COUNT(*)` with a 60 s limit).
- **Structure:** columns, primary key, indexes with cardinality, outgoing and incoming foreign keys, CHECK
  constraints, triggers. **DDL:** `SHOW CREATE TABLE`.
- **Data:**
  - Explicit column lists; long text is truncated server-side.
  - At most 200 rows per page and a 15 s `max_statement_time`.
  - **Keyset pagination** on the primary key, or on (sort column, primary key). There is no `OFFSET`, so page 1,000 costs the same as page 1, and NULL sort keys are handled in both directions.
- **Filters:** up to 5 per query, each with a column from `information_schema`, an operator from an allow-list, and a bound parameter as the value. LIKE wildcards are escaped.
- **Sorting:** sorting a table above 1M rows by a column that no index starts with is refused, with an explanation.
- **Query plan:** each page shows its EXPLAIN plan and warns about full scans.
- **Counts:** "Count matching rows" is capped at 100,000.
- **Relationships:** click a row to see its parents (links) and its children with bounded counts. Foreign-key cells link to the parent row.

## Database objects (Schema Designer)

A catalog of objects, one SQL file each under `sql/objects/<type>/`, with a purpose, dependencies and an example:

| Type | Objects |
|---|---|
| Views | `v_order_summary`, `v_inventory_status`, `v_monthly_category_revenue` (MERGE-able); `v_customer_lifetime`, `v_seller_performance` (aggregating, cheap when filtered on the grouping key thanks to condition pushdown) |
| Functions | `fn_order_balance`, `fn_delivery_days`, `fn_stock_balance` |
| Procedures | `sp_refresh_sales_summaries`, `sp_recalculate_inventory`, `sp_customer_orders`, `sp_order_health` |
| Triggers | `trg_return_items_quantity_guard`, `trg_product_reviews_delivered_guard` (enforce business rules on insert), `trg_orders_status_transition` (valid lifecycle moves), `trg_orders_status_history` (audit into `order_status_history`) |
| Events | `ev_refresh_sales_summaries` (hourly). It only runs while `event_scheduler` is ON; the page explains how a DBA enables it. The app never changes server settings. |
| Indexes | Each index names the query it serves and shows **EXPLAIN** for it: `idx_inventory_movements_time_type` (covering, stock chart), `idx_order_items_product_sales` (covering, revenue per product), `idx_customers_name` (surname prefix search) |

How objects are applied and run:

- **Applying:** objects are applied with the admin account after typed confirmation, in dependency order, using
  `CREATE OR REPLACE` / `IF NOT EXISTS`.
- **Removing:** removal is limited to catalog objects and refused while dependants exist.
- **Job history:** every apply or remove is recorded as a job.
- **Examples:** run with the runtime account (bounded time and rows). Those that modify data need confirmation.
- **Cost of triggers:** the guard triggers also run during generation and import. The Small preset took about 6.6 s with them versus about 5 s without, in this environment.

## Partitioning lab

Builds `exp_orders_partitioned`, a **separate copy** of `orders` partitioned `BY RANGE COLUMNS (purchased_at)`
by month, quarter or year, with a `MAXVALUE` partition. The generated DDL and a rule checklist are shown first:

- the primary key becomes `(order_id, purchased_at)`, because every unique key must contain the partitioning
  column;
- the copy has no foreign keys, because InnoDB does not support them on partitioned tables.

The transactional tables are never partitioned. Rows are copied in resumable units. **Run comparison** executes the
same two queries on both tables, with `EXPLAIN PARTITIONS` and median timings, and checks that results are
identical:

- a date-range aggregate, which is pruned to the matching partitions;
- a lookup by `order_id` alone, which must probe every partition (the trade-off).

## Visual Analytics

13 charts drawn with native SVG from live queries, with one filter row (date presets, category or category group,
seller, status, region) that scopes every chart and the KPI tiles.

- **Data source:** without category, seller, status or region filters, sales charts read `daily_sales_summary`
  and `monthly_sales_summary`; otherwise they aggregate the fact tables over the indexed purchase-date range. Every
  card shows its source table and query time, and lists filters that do not apply to it.
- **Charts:** daily sales, monthly revenue, revenue by category, top 10 products, orders by status, payment methods,
  customer geography, hour × weekday heatmap, delivery-duration histogram (median, p90, late share), cancellation and
  return rates, repeat-purchase share, inventory in/out, and insertion throughput of the latest job.
- **Accessibility:** hover and keyboard tooltips, a legend whenever there are two or more series, a table view for
  every chart, light and dark palettes validated for colour-vision deficiency, and the previous render held at
  reduced opacity while refetching.

Measured on the 10M-row Large dataset in this environment:

| Source | Time |
|---|---|
| Summary-backed charts | 7–38 ms |
| Fact-table charts | 0.15–3.3 s (top products 2.8 s, geography 3.1 s) |
| Filtered fact charts | about 0.5 s |
| Repeat-purchase window query | 2.2–2.6 s |

## Performance Lab

13 scenarios. Read scenarios use the lab tables; **write scenarios touch only `bench_events`**, which is truncated
before and after each run, so business data is never modified.

| Scenario | Operation |
|---|---|
| Bulk INSERT | multi-row batch through the bulk protocol (rows per batch configurable) |
| Single-row INSERT | one autocommitted insert |
| SELECT by primary key | point lookup on `orders` |
| Indexed filtering | latest 20 orders of a customer via `idx_orders_customer_purchased` |
| Full-table scan | aggregate with a predicate on an unindexed column |
| Aggregation / GROUP BY | status breakdown over a random date window |
| Multi-table JOIN | orders × customers × items × products for 50 orders |
| Concurrent reads | mix of the three read shapes above |
| Concurrent writes | inserts plus primary-key updates (configurable share) |
| Mixed read/write | configurable read share |
| Commit throughput | BEGIN, N inserts, one update, COMMIT |
| Pagination | the same deep page with LIMIT/OFFSET and with keyset; reported per variant |
| Analytical | monthly revenue by category over a year of fact data |

**How a run works**

- Concurrency, duration or iteration count, warm-up, per-statement timeout (`max_statement_time`), seed (fixes
  each worker's parameter sequence), a label, and scenario parameters are configurable.
- Each run uses its own connection pool sized to its concurrency.
- The warm-up executes the same operations without recording them.
- **SQL shown as executed.** The configuration form lists the statements of the selected scenario, and the Live run
  panel shows, per variant, the last statement a worker executed with its values inlined for display, its latency
  and how many were measured (refreshed every second). Statement text and display come from the same constants in
  `server/benchmarks/scenarios.js`; values are always sent as bound parameters (including `LIMIT`/`OFFSET` in the
  pagination scenario).
- Runs above the heavy thresholds, or concurrent full scans, need typed confirmation. Nothing else may run at the same time.

**What is measured**

- Operations/s, rows returned/s, and rows written/s.
- Latency mean, p50, p90, p95, p99, p99.9, min and max, from a log-linear histogram accurate to about 1% (unit-tested against exact percentiles). Latency is broken down per variant and per second.
- Errors and statement timeouts are counted separately. A run stops early on a lost connection, or when more than half the operations fail.

**Recorded with every run**

- Server version and InnoDB settings (buffer pool, `innodb_flush_log_at_trx_commit`, flush method, binary logging, isolation).
- Client host CPUs and Node version.
- Dataset size.
- Buffer-pool fill before the run, and page reads versus disk reads during it (the warm/cold indicator).
- Redo log written.

**Comparison** of up to 8 runs is shown side by side with percent changes against a baseline. It warns when
scenarios or server settings differ between the runs.

> **Results describe one environment.** Hardware, storage, cache state, indexes, data volume, server configuration
> and the client running inside the Data Lab process all shape them. Never quote a number without its snapshot.

Example runs on the 10M-row Large dataset (laptop, MariaDB 11.4 in Docker, 512 MiB buffer pool, warm cache, 10 s
each). They show relative behaviour in this one environment, not a benchmark of MariaDB:

| Scenario | Connections | Throughput | p50 / p95 / p99 |
|---|---|---|---|
| SELECT by primary key | 4 | 5,824 ops/s | 0.66 / 0.90 / 1.07 ms |
| Concurrent reads | 8 | 7,418 ops/s | 0.99 / 1.67 / 2.06 ms |
| Pagination, keyset vs OFFSET (pages up to 9,000) | 2 | n/a | keyset 0.91 / 1.34 ms; OFFSET 35 / 68 ms |
| Single-row INSERT | 4 | 1,081 rows/s | 3.6 / 4.3 / 6.2 ms |
| Bulk INSERT (500 rows/batch) | 4 | 118,207 rows/s | 12.7 / 52 / 80 ms per batch |
| Commit throughput (3 inserts + 1 update) | 4 | 668 txn/s | 5.7 / 7.7 / 9.8 ms |
| Full-table scan (495K orders) | 1 | 9.8 ops/s | 99 / 117 / 120 ms |
| Analytical (12 months of fact data) | 1 | 0.5 ops/s | 1.98 / 2.07 s |

## SQL Diagnostics

A read-only page that refreshes every 5 s. It only issues `SELECT` and `SHOW` and never changes server settings.

- **Overview:** version, uptime, threads, and connection limits.
- **Server-wide workload rates:** queries, SELECT/INSERT/UPDATE/DELETE, commits, rows read and written, disk reads,
  redo log, plus a queries-per-second history.
- **InnoDB buffer pool:** usage, dirty pages, and hit ratio (interval and since start).
- **Locks and transactions:** row-lock waits, deadlocks, and history list length.
- **Open InnoDB transactions and sessions.** These need `PROCESS`; otherwise only the account's own sessions are shown, with a note.
- **Statement digests and table I/O** from `performance_schema`. These need it ON and `SELECT` on it.
- **Slow query log status.**
- **Index usage and never-read indexes.** These need `userstat`.
- **Largest tables, key server settings, and the Data Lab's own pool.**

Every section that is unavailable explains why (instrumentation off or a missing grant) and how a DBA can enable it
safely. Rates use MariaDB 11's `Rows_read`/`Handler_*` counters where `Innodb_rows_*` no longer exist.

## Server Assessment

A read-only inventory of the connected MariaDB server, meant as an assessment tool for any server the active
connection profile points to (it does not need the lab schema). It took 0.7 s on the development server (91 tables);
time grows with the number of tables. Only `SELECT` and `SHOW` are issued, on one dedicated connection with a 60 s
`max_statement_time` for that session.

- **Summary:** version, uptime, topology (standalone, replica, primary with replicas, Galera node), user schemas,
  tables, size, storage engines, and the grants of the assessment account.
- **Findings:** heuristic checks with a severity, the evidence and a recommendation. Galera: primary component,
  node state, cluster size and quorum, flow control, non-InnoDB tables. Replication: stopped channels and lag.
  Durability: `sync_binlog`, `innodb_flush_log_at_trx_commit`, binary log. Capacity: buffer pool size and hit
  ratio, peak connections, aborted connections, on-disk temporary tables. Configuration: strict `sql_mode`, slow
  log, `performance_schema`. Schema: tables without a primary key (critical on Galera), MyISAM, non-utf8mb4 schemas,
  tables with more than 1 GiB of free space. Thresholds are conventional starting points, not rules.
- **Cluster & replication:** every `wsrep_*` variable and status counter, the parsed `wsrep_provider_options`,
  all replication channels (`SHOW ALL SLAVES STATUS`, multi-source aware), binary log position, connected
  replicas and semi-sync settings.
- **Schemas** (charset, tables, views, routines, triggers, events, sizes) and **Tables** (engine, row format, rows,
  data, indexes, free space, primary key, index and foreign-key counts, partitioning, collation). The 20,000
  largest tables are read; schema totals are always complete.
- **Parameters:** every global system variable with its default and origin (compiled-in, config file, command line,
  `SET GLOBAL`), filtered to the changed ones by default; **Status counters:** all of `SHOW GLOBAL STATUS`.

**Exports:** a self-contained **HTML report** (print it to PDF from the browser), the full **JSON**, and **CSV** per
dataset (findings, schemas, tables, parameters, status, Galera, replication channels). CSV cells that start with
`=`, `+`, `-` or `@` are prefixed with an apostrophe so spreadsheets do not run them as formulas.

**Credentials are never collected.** Variables that can hold one (`report_password`, `wsrep_sst_auth`, key
management tokens, passwords inside `wsrep_provider_options`, plugin `*_password` / `*_secret` settings) are shown
as `***`. Exports do contain host names, addresses, ports and file paths, which is the point of an assessment;
treat them as internal documents.

It reads with the admin account (or the runtime account when none is set) and only sees what that account may
see. For a complete picture, use an account with the read-only grants in
[docs/PERMISSIONS.md](docs/PERMISSIONS.md#server-assessment); sections it cannot read say which grant is missing.
Galera and replication checks are covered by unit tests on synthetic server states; the development server was a
standalone MariaDB 11.4.

## Olist import

The [Brazilian E-Commerce Public Dataset by Olist](https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce)
is not bundled. Download it yourself and check its licence (listed as CC BY-NC-SA 4.0 on Kaggle). The import asks
you to confirm the licence before it runs. See [datasets/README.md](datasets/README.md) for the file list and a
synthetic fixture you can use to try the flow.

**Pipeline**

1. **Files** (Dataset Sources): put the 9 CSV files in `DATASET_DIR` or upload them (streamed to disk, size-limited,
   only the 9 known names accepted). **Scan** computes SHA-256, counts records, checks headers (any column order,
   case-insensitive) and dry-run validates every record. **Preview** shows the column mapping and the first rows
   with per-field errors.
2. **Staging** (Import Manager): a streaming RFC 4180 parser (quotes, embedded line breaks, BOM, CRLF, multi-byte
   characters across chunks) feeds typed, validated rows into `stg_olist_*`. Each unit of records commits together
   with its ledger row, so an interrupted import resumes exactly after the last committed unit. A resume refuses
   files whose size or modification time changed. Invalid records are counted by reason, and up to 50 per unit are
   kept in `stg_import_rejects`.
3. **Integrity report:** 18 cross-file checks, for example orders without items, items whose product is missing,
   products sold by several sellers, zip prefixes missing from geolocation, and deliveries before pickup. Each check
   says what the transform will do about it.
4. **Transform** into the lab tables, in foreign-key order with the same ledger, retries, pause and resume as
   generation. It requires empty lab tables, like generation. Afterwards run validation as usual.

**Mapping**

| Olist | Lab |
|---|---|
| `customer_unique_id` | `customers`; one `customer_addresses` row per distinct zip prefix |
| `seller_id` | `sellers`, home warehouse = nearest fulfilment centre |
| `product_id` × `seller_id` | `products` (one listing per pair, list price = average selling price), attributes from name/description length and photo count |
| orders, order items (1 unit each) | `orders`, `order_items`; one `shipments` row per seller with label, pickup and delivery `shipment_tracking_events` |
| payments | `payments` + `payment_transactions`, reconciled to the order total |
| reviews | latest review per delivered order, on its first line |
| geolocation | `geographic_locations`, one per zip prefix (mean coordinates inside Brazil, most frequent city) |
| category translation | leaf `product_categories` under the reference category groups |

Attributes Olist does not contain (names, e-mail, phone, addresses, carriers, tracking, stock) are synthesized
deterministically from the seed and the lab id, using the same fictional-identity rules as the generator.

**Repairs.** The source contains records that break the lab's business rules. The transform repairs or skips them
and counts every case in the job statistics (`_fix|…`, `_skip|…`), shown in the job panel. Examples: approval
missing or before purchase; delivery before pickup; "delivered" without a delivery date (imported as shipped);
reviews dated before delivery; payments that do not sum to the order total, the difference added to the last
payment, with the total adjustment reported; zero-value or `not_defined` payments; items whose product is
unknown; orders without items, which are skipped.

**Scaling.** **Compute calibration profile** derives the category mix with median prices, payment mix, customer and
seller state shares, basket size and review coverage from staging. **Open in Data Generator** applies it, and
"Apply scale" sets counts to a multiple of the source. The calibration is stored in the job's configuration
snapshot, so calibrated runs stay reproducible.

**Limitation:** a synthetic run **replaces** the lab data; synthetic rows cannot yet be appended to imported rows
in the same schema.

## Validation report

**Run validation** executes 27 rules, each a query that returns the violating rows. A sample of offending keys is
shown for any failure. The rules cover:

- **Integrity:** no orphans; every order has items; products in leaf categories.
- **Lifecycle:** sellers before products, products before purchase, customers before purchase, shipments after
  approval, delivered and shipped status consistency, canceled orders never shipped, chronological tracking,
  reviews only after delivery.
- **Reconciliation:** subtotal and shipping equal the lines; payments equal the total; payment status matches
  approval; refunds never exceed captures; shipment cost equals item freight; discounts come from live promotions.
- **Returns:** only after delivery; returned quantity at most the purchased quantity; refunds equal returned value.
- **Inventory:** balance equals the movement ledger and is never negative; sale movements equal shipped units.
- **Geography and carts:** zip codes match locations; shipments go to the order's address; converted carts match
  their orders.

On large datasets, several rules force a primary-key scan order (`FORCE INDEX (PRIMARY)`, `STRAIGHT_JOIN`) or
aggregate in primary-key order instead of through a derived table. The optimizer otherwise picks a smaller secondary
index whose order turns every join lookup into random I/O. On the XL dataset this took `tracking_sequence` from a
300 s timeout to 44 s, `zip_consistency` from 207 s to 10 s, `shipment_cost` from 152 s to 10 s and
`payment_total` from 139 s to 6 s; the whole report went from 26 min (with one timeout) to 14.5 min. An integration
test corrupts rows inside a rolled-back transaction to prove the rewritten rules still detect violations.

A realism profile (status mix, payment mix, ratings, top states, repeat rate, late-delivery rate, average delivery
time, return rate) is included. More hand-written checks are in
[sql/verification/verify_generated_data.sql](sql/verification/verify_generated_data.sql).

## Installing into an existing schema

The Data Lab writes an ownership marker (`lab_schema_info`) into its schema and only ever creates, empties or
drops objects with its own names. When the selected schema already contains other objects:

| Situation | Result |
|---|---|
| Unrelated tables only (names the Data Lab never uses, e.g. `test`) | Allowed after ticking **Install alongside the unrelated tables**. They are never read, changed or dropped; the schema is recorded as shared. |
| Any table, view, routine, trigger or event with a name the Data Lab uses (e.g. your own `orders`), and no ownership marker | **Refused.** `CREATE ... IF NOT EXISTS` would silently adopt your object and cleanup could later empty it. Rename or move it, or choose another schema. |
| A table outside the lab with a foreign key to a lab table | Cleanup is refused, because truncating would orphan that table's rows. Remove the foreign key first. |

The ownership marker is written right after the metadata tables are created, so an install that fails half-way can
simply be re-applied.

## Safe cleanup

**Data Generator → Danger zone → Delete generated data** truncates the 29 generated tables of the configured
schema. It requires:

- typing the schema name exactly (checked again on the server),
- the `lab_schema_info` ownership marker in that schema,
- no foreign key from a table outside the lab to a lab table,
- no running job.

It uses `TRUNCATE` with `foreign_key_checks=0` **for that session only**, because all related tables are emptied
together. Job history and `data_generation_audit` are kept. Jobs whose data was deleted can no longer be resumed.
The Olist id map (`map_olist_ids`), `order_status_history` and the partitioning experiment table are emptied with
the data they describe when they exist.

**Import Manager → Clear staging** empties the `stg_olist_*` tables and the reject samples (typed confirmation,
staging tables only, lab tables untouched).
The application never drops tables, schemas or databases, and never touches another schema: schema creation is
refused if the target contains tables the application does not own.

## Security notes

- The browser never connects to MariaDB and cannot submit SQL. Every statement is fixed server-side and
  parameterized; identifiers come from an allow-list and a strict regular expression.
- Passwords are accepted once over the API, kept in server memory (or `.env`), never returned, logged or stored
  in the browser. The UI only shows "set" or "not set".
- The server binds to `127.0.0.1` by default and refuses to start on another address without `APP_ACCESS_TOKEN`.
  It rejects unexpected `Host` headers (DNS rebinding), cross-site requests and foreign `Origin` headers, and every
  API call must carry the `X-DataLab-Request: 1` header, which other sites cannot send. Mutating requests must be
  `application/json`. On a network, also set `APP_ALLOWED_HOSTS` and put TLS in front of it.
- A stored password is never sent to a different host, port, user or TLS mode: changing any of them on the
  Connections page requires re-entering the password.
- One data job at a time; expensive read endpoints have concurrency caps (429 beyond them).
- Strict security headers: CSP `default-src 'self'` with no inline scripts, `X-Frame-Options: DENY`, `nosniff`,
  `no-referrer`.
- Database errors are reduced to code, message and hint; SQL text and parameter values are stripped.
- Separate runtime (DML) and admin (DDL) accounts; see [docs/PERMISSIONS.md](docs/PERMISSIONS.md).
- Generated identities are fictional: names are random combinations, e-mails use the reserved `example.com` and
  `example.net` domains, and phone numbers use the non-existent area code `00`.
- Use a non-production server. Large runs cause sustained I/O, and runs above the threshold require typed
  confirmation.

The threat model, every control and the Phase 5 review findings are in [docs/SECURITY.md](docs/SECURITY.md).

## Testing

```sh
npm test                    # 70 unit tests, no database needed
npm run test:integration    # 37 integration tests against the server in .env, schema "datalab_test"
```

Integration tests use the schema in `DATALAB_TEST_DB_NAME` (default `datalab_test`, same grants as the lab schema)
and are skipped if the server is unreachable. They cover:

- **Generation:** connection diagnostics, authorized and idempotent schema creation, shared schemas (explicit opt-in), refusal of
  name conflicts in unmarked schemas, cleanup blocked by external foreign keys,
  generation plus all business rules, detection of injected violations by the rewritten rules, determinism across worker counts, failed batch recovery without duplicates,
  transient-error retries, pause and continue, cancel and resume to an identical dataset, blocked resume after
  cleanup.
- **Import** (on a generated Olist-format fixture): scan and rejects, the licence gate, exactly-once resume of a
  failed import unit, the replace-staging guard, the integrity report, the transform with repair statistics and
  all business rules, transform determinism, and a calibrated scaled generation.
- **Objects, explorer, analytics:** every catalog object applies and is detected; dependants block removal;
  generation passes every rule with the triggers installed; functions agree with the data; the summary procedure
  is idempotent; triggers block invalid status moves, reviews of undelivered orders and over-returns, and record
  history; keyset pagination visits every row exactly once in order, also with NULL sort keys in both directions
  and with filters; relationships and bounded counts; analytics summary and fact paths agree; filters are reported
  as applied or ignored; injected filter values are rejected; the partition copy is complete, prunes date ranges,
  and probes every partition for id lookups.
- **Performance Lab and diagnostics:** read runs report consistent throughput, ordered percentiles, per-variant counts
  and an environment snapshot; write runs leave business tables unchanged and the scratch table empty; iteration
  mode runs exactly N operations; heavy runs need confirmation and only one job runs at a time; cancellation keeps
  partial results; errors and statement timeouts are counted separately; diagnostics produce rates and every
  optional section is either available or explains itself.

Unit tests cover the PRNG and permutations, business rules on in-memory data, determinism, synthetic-identity
rules, configuration validation, SQL-injection rejection, error sanitization, request parsing, the CSV parser
(including every chunk-boundary split), Olist value validation, calibration sanitizing, explorer filter building
and LIKE escaping, keyset predicates, the integrity of the object catalog, latency-histogram accuracy against exact
percentiles, throughput arithmetic, and benchmark configuration limits (including iteration-mode caps).

HTTP-level tests start the real application on a random port and check the security headers, the access token,
the required request header, `Host`/`Origin`/`Sec-Fetch-Site` rejection, body type and size limits (and that a
rejected body does not poison the connection), prototype-property lookups, static path traversal, upload name and
type checks, and the concurrency limiter.

`node scripts/estimate.js` prints per-table estimates for all presets.

## API

Every call except `/api/health` needs the header `X-DataLab-Request: 1` (and `Authorization: Bearer <token>` when
`APP_ACCESS_TOKEN` is set). Example: `curl -H 'X-DataLab-Request: 1' http://127.0.0.1:8080/api/settings`.

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Liveness (no token needed) |
| `GET /api/settings` | Limits and flags |
| `GET /api/connection` · `POST /api/connection/test` · `POST /api/connection` | Profile, pool status, test, apply |
| `GET /api/schema/status` · `GET /api/schema/ddl` · `POST /api/schema/apply` | Inspect, preview, install (`{confirm, createDatabase}`) |
| `GET /api/generator/presets` · `POST /api/generator/estimate` | Presets and estimates |
| `POST /api/generator/jobs` | Start (`{config, confirmLargeRun}`); returns 428 when confirmation is needed |
| `POST /api/generator/cleanup` | Truncate generated data (`{confirm}`) |
| `GET /api/validation/rules` · `POST /api/validation/jobs` | List rules, run validation |
| `GET /api/jobs?type=&limit=` · `GET /api/jobs/:id` | Job list and detail (live progress, failed units) |
| `GET /api/jobs/:id/events` | Server-Sent Events stream of the job detail until it stops |
| `POST /api/jobs/:id/{pause,unpause,cancel,resume}` | Job control (generation and import jobs) |
| `GET /api/datasets` · `POST /api/datasets/scan` · `GET /api/datasets/:key/preview` | File inventory, scan, preview |
| `PUT /api/datasets/files/:name` | Upload one known Olist file (`text/csv` body) |
| `GET /api/import/staging` · `GET /api/import/rejects?job=&file=` | Integrity report, rejected-record samples |
| `POST /api/import/jobs` | Stage CSV files (`{licenseAccepted, files, replaceStaging, confirm, config}`) |
| `POST /api/import/transform` · `POST /api/import/staging/clear` | Transform to lab tables; clear staging (`{confirm}`) |
| `GET /api/import/calibration` | Calibration profile computed from staging |
| `GET /api/explorer/tables` · `GET /api/explorer/tables/:table` · `…/ddl` · `…/exact-count` | Table list, structure, DDL, exact count |
| `GET /api/explorer/tables/:table/rows?sort=&dir=&limit=&cursor=&filters=` | Keyset page (filters as JSON) |
| `GET /api/explorer/tables/:table/count?filters=` · `…/related?key=` | Capped matching count; parents and children of one row |
| `GET /api/objects` · `GET /api/objects/:name/definition` · `GET /api/objects/:name/explain` | Catalog status, DDL, EXPLAIN for indexes |
| `POST /api/objects/apply` · `POST /api/objects/:name/remove` · `POST /api/objects/:name/example` | Apply (`{names, confirm}`), remove (`{confirm}`), run example (`{confirmModify}`) |
| `GET /api/partitioning/plan` · `GET /api/partitioning/status` | Generated DDL with rule checks; partitions of the experiment |
| `POST /api/partitioning/create` · `…/compare` · `…/drop` | Create and copy (job), pruning comparison, drop the experiment table |
| `GET /api/analytics/options` · `GET /api/analytics/charts/:chart?from=&to=&category=&seller=&status=&region=` | Filter options; one chart (source, ms, applied/ignored filters, data) |
| `GET /api/benchmarks/scenarios` · `POST /api/benchmarks/runs` | Scenario catalog and limits; start a run (`{scenario, concurrency, mode, durationSec \| iterations, warmupSec, opTimeoutMs, seed, label, params, confirmHeavy}`; 428 when confirmation is needed) |
| `GET /api/benchmarks/runs?scenario=` · `GET /api/benchmarks/compare?ids=a,b` | Run history; up to 8 runs with config, result and environment |
| `GET /api/diagnostics` | Read-only snapshot with rates since the previous call (at least 1 s apart) |
| `GET /api/assessment` | Read-only server assessment (parameters, status, cluster, replication, schemas, tables, findings) |
| `GET /api/overview` | KPIs, recent jobs, schema objects |

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `ECONNREFUSED` | MariaDB not running or wrong port. Check `DB_PORT`; the Docker example uses 3307. |
| `ER_ACCESS_DENIED_ERROR` | Wrong password, or the user is not allowed from this host (`'user'@'host'`). |
| `ER_BAD_DB_ERROR` / "database does not exist" | Create it on the Schema Designer page (needs the admin account). |
| `ER_DBACCESS_DENIED_ERROR`, `ER_TABLEACCESS_DENIED_ERROR` | Missing grants; see docs/PERMISSIONS.md. Cleanup needs `DROP` because `TRUNCATE` requires it. |
| Schema apply returns 409 "table(s) not managed" | The schema holds unrelated tables; tick "Install alongside the unrelated tables", or use a dedicated schema. |
| Schema status "blocked" / 409 "names it uses" | Objects with Data Lab names exist in an unmarked schema; rename or move them, or choose another schema. |
| Pages return 409 "lab schema is not installed in …" | The selected schema has no lab tables yet; apply it on the Schema Designer page. |
| Start returns 409 "already contains generated data" | Resume the previous job (Job History) or delete generated data first. |
| Start returns 428 | The run is above `GEN_CONFIRM_ROWS_THRESHOLD`; confirm in the dialog. |
| Job status `interrupted` | The server stopped while the job ran. Open it and click **Resume**. |
| Units fail with lock or deadlock errors repeatedly | Lower `workers`, raise `innodb_lock_wait_timeout`, or check for other load on the server. |
| Slow generation | Larger `innodb_buffer_pool_size`, faster storage, more `workers` (bounded by `DB_POOL_SIZE`), larger `commitInterval`. Check `innodb_flush_log_at_trx_commit` on a test server only. |
| Sizes and row counts look too low | They come from InnoDB statistics, which lag after bulk loads. Run `ANALYZE TABLE` or wait for automatic recalculation. KPI cards label exact vs. estimated counts. |
| Validation rule shows `error` | Usually `max_statement_time` on a very large dataset. Raise `VALIDATION_STATEMENT_TIMEOUT_SEC`. |
| 401 in the browser | `APP_ACCESS_TOKEN` is set; enter it on the Settings page. |
| 403 "Missing X-DataLab-Request header" | A script or tool calls the API directly; add the header `X-DataLab-Request: 1`. |
| 421 "Unexpected Host header" | You opened the app under a name that is not allowed; add it to `APP_ALLOWED_HOSTS`. |
| 429 "Too many concurrent … requests" | A concurrency cap on an expensive endpoint; retry when the earlier request finishes. |
| Server exits with "refusing to start" | Non-loopback `APP_HOST` without a token, or a token shorter than 16 characters. |
| Connections: "password: re-enter it" | You changed host, port, user or TLS mode; the stored password is never sent to a new endpoint. |
| "Run example" fails with `ER_PROCACCESS_DENIED_ERROR` | Grant `EXECUTE` on the lab schema to the runtime account. |
| Event shows "installed" but never runs | `event_scheduler` is OFF on the server; a DBA must enable it. |
| Explorer: "needs a full sort because no index starts with it" | The table has more than 1M rows; sort by an indexed column, or add an index for that query pattern. |
| Explorer or chart: "exceeded … s" | `max_statement_time` stopped a heavy query; add a filter on an indexed column or narrow the date range. |
| Partition experiment 409 "already exists" | Drop the experiment table first (it is a copy; `orders` is not touched). |
| Benchmark returns 428 | The run is above `BENCH_HEAVY_*`; confirm in the dialog (type RUN). |
| Benchmark numbers vary between runs | Compare the environment snapshots: cache state (hit ratio), other load on the server, buffer pool, flush settings. Use a warm-up and longer runs. |
| Diagnostics: transactions or sessions "unavailable" | Grant `PROCESS` to the runtime account (read-only), or accept own-sessions-only. |
| Diagnostics: performance_schema "unavailable" | It is OFF (needs `performance_schema=ON` in the server config and a restart) or the account lacks `SELECT` on it. |
| "lab schema is not installed" after upgrading | Schema version 2 added staging tables; re-apply the schema (adds tables only). |
| Import: header check fails | A required column is missing or misspelled. The real files use the typo `product_name_lenght`; the importer expects exactly that. |
| Import: 409 "staging tables already contain rows" | Tick "replace staged data" and type the schema name, or clear staging. |
| Import resume refused: "file changed" | The CSV was replaced after the import started; start a new import. |
| Transform: 409 "lab tables already contain data" | Delete generated data first (Data Generator → Danger zone). |
| Upload 413 | File larger than `IMPORT_MAX_UPLOAD_MB`; raise it or copy the file into `DATASET_DIR` directly. |

## Project structure

```
public/                 Vanilla frontend (index.html, css/, js/app.js router, js/charts.js SVG charts, js/pages/*)
server/
  server.js             Entry point: deployment checks, listen, graceful shutdown
  app.js                HTTP application: static files, auth, origin checks, concurrency caps
  config.js  db.js      Environment config; pool, profiles, diagnostics, error sanitizing
  http.js  logger.js    Router, JSON helpers, structured logs (never credentials)
  routes/api.js         REST endpoints
  services/             Schema install/status/cleanup, overview KPIs, explorer, objects, partitioning, analytics,
                        diagnostics, server assessment
  generators/           PRNG, reference data, e-commerce model, presets, estimator, calibration profiles
  importers/            CSV parser, Olist definitions, dataset files, staging import, transform, calibration
  jobs/                 Job store, unit/ledger engine (generation and imports), job manager
  benchmarks/           Scenarios, runner, latency histogram, environment snapshot
  validators/           Business-rule SQL and realism profile
sql/schema/             DDL (applied in order; 060 staging tables, 070 objects job type, 080 benchmark scratch table)
sql/objects/            Database object catalog (tables, functions, views, procedures, triggers, events, indexes)
sql/verification/       Example verification queries
docs/                   ERD and table purposes, permissions, security model
datasets/               Notes on the Olist reference dataset (nothing bundled); raw/ is git-ignored
scripts/estimate.js     Preset estimates from the command line
scripts/make-olist-fixture.js  Synthetic Olist-format files for tests and demos
tests/unit, tests/integration
```
