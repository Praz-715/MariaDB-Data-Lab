# Project: OracleDB Data Lab — Realistic Data Generator, Database Lab and Server Assessment for Oracle Database

This document is the complete build specification for **OracleDB Data Lab**, the Oracle Database counterpart of
**MariaDB Data Lab** (this repository). It consolidates everything MariaDB Data Lab does, phase by phase, translated to
Oracle Database, plus the lessons learned while building it. Hand it to the builder (a developer or an AI coding agent)
as the single source of requirements.

How to read it:

- **Sections 1–6** are the rules, constraints and architecture. They apply to every phase.
- **Sections 7–19** describe each feature: what MariaDB Data Lab does, and exactly how it must work on Oracle.
- **Section 20** is the phased delivery plan with acceptance criteria.
- **Section 21** lists the pitfalls already hit in MariaDB Data Lab. Read it before writing code.
- **Section 22** is a MariaDB → Oracle translation cheat sheet; **Section 23** lists decisions to settle first.

Where this document states an Oracle version limit, licence boundary or resource limit, the builder must verify it
against the Oracle documentation for the exact release used. Licensing statements here are guidance, not legal advice.

---

## 1. Goal

A framework-free web application that:

1. Generates realistic, relationally consistent, **deterministic** synthetic e-commerce data in an Oracle schema
   (Small ≈ 100K rows to XL ≈ 50M rows), with resumable, exactly-once bulk-loading jobs.
2. Imports a public reference dataset (Olist Brazilian e-commerce) through validated staging into the lab tables,
   with a repair report and a calibration profile for scaled synthetic generation.
3. Validates the data against 27 business rules expressed as SQL.
4. Lets the user explore tables (keyset pagination, filters, relationships, execution plans), create a catalog of
   database objects (views, PL/SQL, triggers, scheduler jobs, indexes, materialized views), and experiment with
   partitioning on a copy.
5. Visualizes the data (13 accessible SVG charts from live queries).
6. Benchmarks the server (13+ scenarios, latency percentiles, environment snapshots, run comparison, live view of the
   SQL being executed).
7. Diagnoses the server read-only (sessions, waits, top SQL, buffer cache, redo, undo, tablespaces).
8. **Assesses any Oracle database** the connection points to: parameters, statistics, RAC / Data Guard / multitenant
   topology, schemas, tables, tablespaces, heuristic findings, and exports (HTML report, JSON, CSV).

The application is a **lab for non-production databases**. The assessment is read-only and may be pointed at any
database the operator is authorized to inspect.

## 2. Non-negotiable rules

Carried over unchanged from MariaDB Data Lab:

- The browser never connects to the database. Credentials stay server-side.
- No arbitrary SQL from the browser. Every statement is fixed server-side; values are **bind variables**; identifiers
  come from allow-lists (checked with `Object.hasOwn`, never plain property lookup).
- Input validation on every endpoint, connection pooling, configuration through environment variables, safe error
  messages (code, message, hint; never SQL text, bind values or stack traces).
- Passwords are never displayed after submission, never logged, never stored in browser storage, and never returned
  by the API. A stored password is **never forwarded** to a different host, port, service name, user or TLS mode.
- Separate accounts: a **runtime** account (DML only, via object grants) and an **owner/admin** account (DDL in the lab
  schema only). Assessment uses a read-only dictionary account.
- **Explicit, typed authorization** before creating schema objects, deleting data, or running heavy work.
- **Never drop** users, schemas, tablespaces, pluggable databases or databases. Ever. The app does not create or drop
  users either; a DBA script does (section 5).
- **Never truncate or delete outside the configured lab schema**, and inside it only objects the app owns (ownership
  marker + name allow-list).
- **Never change server-wide configuration**: no `ALTER SYSTEM`, no `ALTER DATABASE`, no `ALTER SYSTEM FLUSH
  BUFFER_CACHE/SHARED_POOL`, no Resource Manager changes, no `DBMS_STATS` on other schemas, no `DBMS_SCHEDULER`
  attribute changes on jobs the app does not own. `ALTER SESSION` on the app's own sessions is allowed.
- Never use real personal data. Names are random combinations; e-mail addresses use the reserved `example.com` /
  `example.net` domains; phone numbers use a non-existent area code.
- Never present fake data as real; never replace a missing feature with mock data. Every number in the UI comes from
  a real query, labelled as exact or estimated.
- Do not redistribute source datasets; require the operator to confirm the dataset licence before import.
- Require explicit confirmation before tests that create substantial CPU, memory, I/O, redo, undo or temp load.
- Never claim benchmark results are representative; always record and show the environment.

**New, Oracle-specific rules:**

- **Licensed features are opt-in and detected, never assumed.** The following must not be queried or used unless the
  operator explicitly confirms the licence on the Settings page (stored server-side, shown on every affected page):
  - **Diagnostics Pack**: AWR (`DBA_HIST_*`), ASH (`V$ACTIVE_SESSION_HISTORY`, `DBA_HIST_ACTIVE_SESS_HISTORY`), ADDM,
    `DBMS_WORKLOAD_REPOSITORY`. Also check `control_management_pack_access` and respect `NONE`.
  - **Tuning Pack**: SQL Monitoring (`V$SQL_MONITOR`, `DBMS_SQL_MONITOR`), SQL Tuning Advisor, SQL Access Advisor.
  - **Partitioning option** (Enterprise Edition): the partitioning lab is disabled unless `V$OPTION` reports
    `Partitioning = TRUE` **and** the operator confirms the licence (Free/XE editions include it for development;
    verify for the edition used).
  - **Advanced Compression**, **In-Memory**, **Real Application Testing**: not used by the lab.
  - Features that need Enterprise Edition (bitmap indexes, online index rebuild, parallel execution) are used only
    when the edition supports them, detected from `V$VERSION` / `V$OPTION`.
- Free dynamic performance views that need no pack (`V$SYSSTAT`, `V$SYSTEM_EVENT`, `V$SESSION`, `V$SQLSTATS`,
  `V$SQL`, `V$OSSTAT`, `V$SGASTAT`, `V$PGASTAT`, `V$PARAMETER`, `V$LOG`, `V$UNDOSTAT`, `V$INSTANCE`, `V$DATABASE`) are
  the default sources for diagnostics and assessment. `EXPLAIN PLAN` and `DBMS_XPLAN.DISPLAY` / `DISPLAY_CURSOR` are
  allowed.
- Never read `SYS.USER$`, password hashes, wallet contents or `DBA_USERS` password columns. Default-password checks use
  `DBA_USERS_WITH_DEFPWD` (names only).

## 3. Technology and constraints

- **Backend:** Node.js (LTS, ≥ 20), native `node:http`. The **only runtime dependency** is the official
  [`oracledb`](https://www.npmjs.com/package/oracledb) driver (node-oracledb 6.x), used in **Thin mode** (pure
  JavaScript, no Instant Client). Thick mode only if a required feature needs it, documented with the reason.
- **Frontend:** vanilla HTML, CSS and ES modules. No React/Vue/Angular, no Express, no Bootstrap/Tailwind, no build
  step, no bundler. No Python, PHP or Java in the application.
- **Database:** Oracle Database 19c (long-term release) and 23ai. Develop against **Oracle Database 23ai Free** in a
  container (`container-registry.oracle.com/database/free`, or the community `gvenzl/oracle-free` images), connect to
  the **pluggable database** service (e.g. `FREEPDB1`), never to `CDB$ROOT`.
  - Oracle Database Free has resource caps (at the time of writing roughly 2 CPU threads, 2 GB RAM and 12 GB of user
    data — verify). The **XL preset will not fit** in Free; XL is for licensed test servers. The generator must check
    tablespace quota and free space before starting (section 9).
  - Code must run on 19c: do not depend on 23ai-only syntax (`CREATE TABLE IF NOT EXISTS`, `BOOLEAN` columns, SQL
    domains, `JSON` relational duality) unless guarded by a version check with a 19c fallback.
- **Driver usage rules:**
  - Bind variables (`:name` or `:1`); never interpolate values. Identifiers only from allow-lists, quoted when needed.
  - `autoCommit` stays **false**; every unit commits explicitly with its ledger row.
  - Bulk inserts with `connection.executeMany(sql, rows, { bindDefs, batchErrors: false })` — define `bindDefs`
    (type and `maxSize`) so the driver does not scan every row.
  - Results with `outFormat: oracledb.OUT_FORMAT_OBJECT`; select lists use **quoted camelCase aliases**
    (`order_id AS "orderId"`) so keys do not arrive in UPPERCASE.
  - `fetchTypeHandler` / `fetchAsString` for `NUMBER` columns that can exceed 2^53, for `CLOB` (as string, bounded),
    and for `DATE`/`TIMESTAMP` (ISO strings in UTC).
  - Statement time limits through `connection.callTimeout` (milliseconds). Set it per acquired connection and reset it
    before release. A connection that hit the call timeout may be unusable: close it with `{ drop: true }`.
  - Every session runs `ALTER SESSION SET TIME_ZONE = '+00:00'`, `NLS_DATE_FORMAT`, `NLS_TIMESTAMP_FORMAT`,
    `NLS_NUMERIC_CHARACTERS = '.,'` (pool `sessionCallback`), so formats never depend on the client host.
  - Large reads stream with `queryStream()` / result sets; never fetch unbounded rows into memory.
  - Pools: `oracledb.createPool({ poolMin, poolMax, poolIncrement, queueTimeout, stmtCacheSize })`; one dedicated pool
    per benchmark run, sized to its concurrency.

## 4. Architecture

Reuse as much as possible from MariaDB Data Lab. These parts are database-agnostic and should be ported nearly
verbatim:

| Module | Reuse |
|---|---|
| `public/` (router, `ui.js`, `charts.js`, pages, CSS, dark mode) | Port; change labels and Oracle-specific fields |
| `server/http.js`, `server/app.js`, `server/logger.js` | Port unchanged (security layer, limiter, router) |
| `server/generators/` (PRNG, reference data, e-commerce model, presets, estimator, calibration) | Port unchanged |
| `server/importers/csv.js`, Olist file definitions, calibration | Port unchanged |
| `server/jobs/` (job store, unit/ledger engine, job manager, `withSlot`) | Port the logic; rewrite SQL |
| `server/benchmarks/metrics.js` (latency histogram), `public/js/assessmentExport.js` | Port unchanged |
| `server/db.js`, `sql/`, services, validators, diagnostics, assessment | **Rewrite for Oracle** |

Project layout:

```
public/                 index.html, css/, js/app.js (router), js/ui.js, js/charts.js, js/assessmentExport.js, js/pages/*
server/
  server.js             Entry: deployment checks, listen, graceful shutdown, job recovery
  app.js                HTTP app: static files, auth, origin checks, concurrency caps
  config.js db.js       Environment config; pools, profiles, session setup, error mapping, retry classification
  http.js logger.js     Router, JSON helpers, limiter, structured logs (never credentials)
  routes/api.js         REST endpoints
  services/             schema, overview, explorer, objects, partitioning, analytics, diagnostics, assessment
  generators/ importers/ jobs/ benchmarks/ validators/
sql/schema/             DDL files applied in order (idempotent)
sql/objects/<type>/     Object catalog, one file per object with header metadata
sql/dba/                Scripts for the DBA: create users, grants, quotas (never run by the app)
docs/                   ERD.md, PERMISSIONS.md, SECURITY.md, LICENSING.md
datasets/               README (nothing bundled); raw/ is git-ignored
tests/unit, tests/integration
```

## 5. Accounts, schema and connection

**Oracle model.** A schema is a user. The lab lives in a dedicated schema user, by default `DATALAB` (tests:
`DATALAB_TEST`), in a pluggable database.

| Account | Purpose | Privileges (granted by the DBA script, never by the app) |
|---|---|---|
| `DATALAB` (owner / admin) | Owns every lab object; used for DDL, cleanup, object catalog, grants to the runtime user | `CREATE SESSION`, `CREATE TABLE`, `CREATE VIEW`, `CREATE SEQUENCE`, `CREATE PROCEDURE`, `CREATE TRIGGER`, `CREATE MATERIALIZED VIEW`, `CREATE JOB`, `QUOTA <n> ON <tablespace>`. **No `ANY` privileges, no `DBA` role.** |
| `DATALAB_APP` (runtime) | Generation, import, explorer, analytics, benchmarks | `CREATE SESSION` only; object privileges (`SELECT/INSERT/UPDATE/DELETE`, `EXECUTE` on catalog PL/SQL) granted by the owner after each schema apply. Sessions run `ALTER SESSION SET CURRENT_SCHEMA = DATALAB`. |
| Assessment account (optional) | Read-only inspection of any database | `CREATE SESSION`, `SELECT_CATALOG_ROLE` (or `SELECT ANY DICTIONARY`). No DML. |

`sql/dba/01_create_lab_users.sql` creates the users, quota and grants; the README shows how to run it in the dev
container. The app checks on the Connections page that the accounts have exactly what they need and reports missing
or **excess** privileges (warn about `DBA`, `ANY` privileges, `SYSDBA`).

**Connection profile:** Easy Connect (`host:port/service_name`) or a TNS alias with `TNS_ADMIN`. TLS via `tcps://`
with a wallet path (`DB_WALLET_DIR`) or system CA; `DB_SSL_SERVER_DN_MATCH` on by default. The Connections page may
replace the profile in memory (`ALLOW_CONNECTION_OVERRIDE`, default on only for a loopback bind), with the Phase 5
rules: re-enter passwords for any endpoint/user/TLS change, TLS never weaker than `.env`, optional host allow-list.

**Connection diagnostics** (Test button): version banner and edition, CDB/PDB name and open mode, current user and
schema, session time zone, database character set (`AL32UTF8` expected; warn otherwise), NLS settings, granted roles
and privileges, quota and free space in the default tablespace, and actionable hints for `ORA-01017`, `ORA-12514`,
`ORA-12541`, `ORA-12170`, `ORA-28000`, `ORA-28001`, `ORA-01045`, `NJS-` driver errors.

**Ownership marker and shared schemas** (as in MariaDB Data Lab after Phase 5): `LAB_SCHEMA_INFO` holds
`app = oracledb-data-lab`, `schema_version`, `shared_schema`. Rules:

- Installing into a schema without the marker that already contains **any object whose name the lab uses** (tables,
  views, sequences, PL/SQL, triggers, scheduler jobs, materialized views) is refused, listing the conflicts.
- Unrelated objects may stay only after an explicit "install alongside unrelated objects" opt-in; they are never
  read, changed or dropped.
- The marker is written right after `LAB_SCHEMA_INFO` is created, so a half-finished install can be re-applied.
- Cleanup is refused while any foreign key **outside** the lab (another schema, or an unrelated table in a shared
  schema) references a lab table.

## 6. Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `APP_HOST`, `APP_PORT` | `127.0.0.1`, `8080` | Listen address. Refuse to start on a non-loopback address without a token. |
| `APP_ACCESS_TOKEN` | empty | Bearer token, at least 16 characters; mandatory on a network bind. |
| `APP_ALLOWED_HOSTS` | empty | Extra `Host` names accepted (DNS-rebinding protection). |
| `ALLOW_CONNECTION_OVERRIDE` | `true` on loopback | Connections page may replace the profile in memory. |
| `DB_CONNECT_STRING` | `localhost:1521/FREEPDB1` | Easy Connect string or TNS alias. |
| `DB_USER`, `DB_PASSWORD` | `DATALAB_APP` | Runtime account. |
| `DB_SCHEMA` | `DATALAB` | Lab schema (owner). System schemas (`SYS`, `SYSTEM`, Oracle-maintained users) are rejected. |
| `DB_ADMIN_USER`, `DB_ADMIN_PASSWORD` | `DATALAB` | Owner account for DDL and cleanup. |
| `DB_ASSESS_USER`, `DB_ASSESS_PASSWORD` | empty | Optional dictionary-reader account for Diagnostics/Assessment (falls back to admin). |
| `DB_WALLET_DIR`, `DB_WALLET_PASSWORD`, `TNS_ADMIN` | empty | TLS wallet / tnsnames location. |
| `DB_POOL_MAX`, `DB_CONNECT_TIMEOUT_SEC`, `DB_STMT_CACHE_SIZE` | `10`, `10`, `50` | Pool settings. |
| `DB_OVERRIDE_HOST_ALLOWLIST` | empty | Hosts the Connections page may switch to. |
| `GEN_MAX_WORKERS`, `GEN_MAX_TOTAL_ROWS`, `GEN_CONFIRM_ROWS_THRESHOLD` | `8`, `60000000`, `1000000` | Generation limits. |
| `VALIDATION_CALL_TIMEOUT_SEC` | `300` | Call timeout per validation rule. |
| `DATASET_DIR`, `IMPORT_MAX_UPLOAD_MB` | `datasets/raw`, `1024` | Olist import. |
| `BENCH_MAX_CONCURRENCY`, `BENCH_MAX_DURATION_SEC`, `BENCH_HEAVY_*` | `32`, `600`, `8/60/100000` | Benchmark limits and heavy thresholds. |
| `LICENSE_DIAGNOSTICS_PACK`, `LICENSE_TUNING_PACK`, `LICENSE_PARTITIONING` | `false` | Initial licence confirmations (also editable on Settings, typed confirmation). |

## 7. Schema (45 tables + optional objects)

Same logical model as MariaDB Data Lab (`docs/ERD.md` in this repository): an Olist-like Brazilian marketplace.

| Layer | Tables |
|---|---|
| Metadata (3) | `LAB_SCHEMA_INFO`, `LAB_JOBS`, `LAB_JOB_BATCHES` |
| Reference (6) | `CURRENCIES`, `GEOGRAPHIC_LOCATIONS`, `CUSTOMER_SEGMENTS`, `SHIPPING_CARRIERS`, `WAREHOUSES`, `PRODUCT_CATEGORIES` (two-level tree) |
| Master (8) | `CUSTOMERS`, `CUSTOMER_ADDRESSES`, `SELLERS`, `SELLER_ADDRESSES`, `PRODUCTS`, `PRODUCT_ATTRIBUTES`, `PROMOTIONS`, `INVENTORY` |
| Transaction (13) | `ORDERS`, `SHIPMENTS`, `ORDER_ITEMS`, `SHIPMENT_TRACKING_EVENTS`, `PAYMENTS`, `PAYMENT_TRANSACTIONS`, `ORDER_RETURNS`, `RETURN_ITEMS`, `PRODUCT_REVIEWS`, `PROMOTION_REDEMPTIONS`, `SHOPPING_CARTS`, `SHOPPING_CART_ITEMS`, `INVENTORY_MOVEMENTS` |
| Analytics (3) | `DAILY_SALES_SUMMARY`, `MONTHLY_SALES_SUMMARY`, `DATA_GENERATION_AUDIT` (kept across cleanup) |
| Staging (11) | `STG_OLIST_CATEGORY_TRANSLATION`, `STG_OLIST_GEOLOCATION`, `STG_OLIST_CUSTOMERS`, `STG_OLIST_SELLERS`, `STG_OLIST_PRODUCTS`, `STG_OLIST_ORDERS`, `STG_OLIST_ORDER_ITEMS`, `STG_OLIST_PAYMENTS`, `STG_OLIST_REVIEWS`, `STG_IMPORT_REJECTS`, `MAP_OLIST_IDS` |
| Benchmark (1) | `BENCH_EVENTS` (scratch table for write scenarios) |
| Optional | `ORDER_STATUS_HISTORY` (trigger audit), `EXP_ORDERS_PARTITIONED` (partitioning lab) |

**DDL conventions:**

- Unquoted identifiers (stored UPPERCASE), at most **30 characters** (keeps 19c-and-older compatibility and short
  constraint names), never a reserved word: an integration test checks every table, column and alias name against
  `V$RESERVED_WORDS WHERE RESERVED = 'Y' OR RES_SEMI = 'Y'`.
- Types: `NUMBER(19)` ids, `NUMBER(12,2)` money (computed in integer cents in JS), `NUMBER(10)`/`NUMBER(5)` counts,
  `VARCHAR2(n CHAR)` text, `TIMESTAMP(3)` event times (UTC), `DATE` for calendar dates, `CLOB` for long text, booleans
  as `NUMBER(1) CHECK (x IN (0,1))` (19c has no `BOOLEAN` column), JSON in `CLOB CHECK (col IS JSON)` on 19c (native
  `JSON` on 21c+ behind a version check).
- **Ids are assigned by the generator** (deterministic). Use `GENERATED BY DEFAULT ON NULL AS IDENTITY` only where the
  database must assign ids (`INVENTORY_MOVEMENTS.MOVEMENT_ID`, `BENCH_EVENTS.EVENT_ID`, job tables), with
  `CACHE 1000`. After loading explicit ids into an identity column, resynchronise it with
  `ALTER TABLE t MODIFY id GENERATED BY DEFAULT ON NULL AS IDENTITY (START WITH LIMIT VALUE)`.
- Every table has a primary key; every foreign key column has an index (Oracle locks the child table on parent
  DELETE/PK UPDATE without one; the assessment flags this too).
- CHECK constraints for the business invariants (for example `total_amount = subtotal + shipping_total -
  discount_total`), named `CK_<table>_<rule>`; FKs `FK_<child>_<parent>`; indexes `IX_<table>_<cols>`.
- **Empty string is NULL in Oracle.** Required `VARCHAR2` columns can never hold `''`; the generator and importer must
  never produce empty strings for required fields, and validation treats `''` and NULL as the same.
- Idempotent apply: create statements run in order; on 19c an "already exists" error (`ORA-00955`, `ORA-02275`,
  `ORA-01430`, `ORA-02260`, `ORA-02261`, `ORA-01408`) for an object the lab owns is treated as success. Schema upgrades
  are versioned (`schema_version`), additive only, and never drop anything.
- After DDL, the owner grants object privileges to the runtime user; the apply report lists them.
- Tablespace: the owner's default tablespace. Show quota (`USER_TS_QUOTAS`) and free space on the Schema page.

## 8. Data generator

Port the MariaDB Data Lab generator unchanged in behaviour (`server/generators/`):

- **Business model:** customers and sellers across 55 Brazilian cities in all 27 states (145 CEP prefixes inside real
  ranges), 11 category groups with up to 400 leaf categories, category-specific lognormal prices and weights,
  promotions including Black Friday, fictional carriers and fulfilment centres.
- **Realism:** growth over the window, monthly and weekday seasonality, hour-of-day curve, holiday peaks; power-law
  product and customer popularity (first-purchase permutation + bucketed Zipf ranks, repeat buyers ≈ 30% in Medium);
  payment-method-driven approval (boleto ≈ 1 day, ≈ 8% unpaid), card declines and retries, cancellations, seller
  handling time, carrier and distance transit, ≈ 7% late deliveries and failed attempts; late deliveries double
  returns and lower ratings (≈ 4.05 on time vs 2.56 late); refunds, restock movements, split payments with vouchers.
  Orders near the end of the window remain in early states.
- **Money in integer cents**; totals and payment sums match exactly.
- **Determinism:** every entity is a pure function of `(seed, entity id)` via a seeded sfc32 PRNG per entity
  (`new Rng(seed, stream, id)`); cross-references recompute the referenced entity instead of reading the database.
  Same configuration + seed ⇒ identical data regardless of worker count and resume points (verified by per-table
  content hashes in integration tests, e.g. `SUM(ORA_HASH(col1 || '|' || col2 ...))` over a stable column list).
- **Presets:** Small (6K customers / 4.7K orders, ≈ 99K rows), Medium (≈ 994K), Large (≈ 10M), XL (3.2M customers /
  2.48M orders, ≈ 49.8M rows). Estimates come from running the generator on sampled ids. Show Oracle size estimates
  (rows × average row length from the generator + index overhead) and compare with free quota **before** starting;
  refuse runs that would exceed it (`ORA-01536` / `ORA-01653` must not be the first sign).
- Runs above `GEN_CONFIRM_ROWS_THRESHOLD` need typed confirmation. A new run refuses to start while generated tables
  hold rows (no mixed datasets).
- After a run, gather statistics for the **lab schema only**:
  `DBMS_STATS.GATHER_SCHEMA_STATS(ownname => 'DATALAB', ...)` as the owner (it is a lab-scope operation, recorded as a
  job step); estimated counts on every page come from `USER_TABLES.NUM_ROWS` labelled "estimated (statistics of
  <LAST_ANALYZED>)".

## 9. Job engine

Port `server/jobs/` behaviour exactly:

- Phases in foreign-key order (reference, customers, sellers, products, orders with items/shipments/tracking/
  payments/returns/reviews/sale movements, carts, stock movements, inventory balances, summaries), each split into
  **units** of `commitInterval` entities; inserts with `executeMany` in chunks of `batchSize`; **one transaction per
  unit, committed together with its ledger row in `LAB_JOB_BATCHES`** ⇒ exactly-once resume.
- `workers` units in parallel (bounded by `GEN_MAX_WORKERS` and the pool), per-phase concurrency, lazy unit lists,
  pause / continue / cancel / resume, `interrupted` on restart, automatic recovery listing.
- Retry transient errors up to 4 times with backoff: `ORA-00060` (deadlock), `ORA-00054` / `ORA-30006` (resource busy /
  wait timeout), `ORA-08177` (serialization), `ORA-03113`, `ORA-03114`, `ORA-03135`, `ORA-12571` (lost connection),
  `ORA-00018`/`ORA-00020` (sessions/processes exceeded), pool queue timeouts. Other errors mark the unit `failed`;
  after 5 failed units the phase stops; Resume retries only what is missing.
- One data job at a time across generation, import, transform, cleanup, validation, objects, partition experiment and
  benchmark; job start is serialized with a synchronous slot (`withSlot`) so two simultaneous requests cannot both
  pass the check.
- Progress: rows, rows/s over a **30-second window** that always keeps one sample at the window edge (no absurd rates
  after host sleep), average, ETA, per-table counts, counted repairs/skips/rejections (`_fix|`, `_skip|`, `_rej|`).
  Live updates via **Server-Sent Events**.
- Inventory balances: read movements without locking and write balances in bulk (never `INSERT ... SELECT` into the
  same table from many workers).
- Summaries via `MERGE INTO DAILY_SALES_SUMMARY ...` per month, idempotent.
- Audit rows per table per job in `DATA_GENERATION_AUDIT`.
- **Cleanup** (typed confirmation, marker required, no running job, no external FKs): Oracle cannot `TRUNCATE` a
  parent table referenced by an enabled foreign key (`ORA-02266`) even when the child is empty. Disable the lab's own
  FK constraints that reference the tables being emptied, `TRUNCATE` children before parents, re-enable with
  `ENABLE VALIDATE` (cheap on empty tables), all as the owner; restore constraints in a `finally` block and report any
  that could not be re-enabled. Reset identity columns. Job history and the audit table are kept.

## 10. Olist import

Same pipeline as MariaDB Data Lab:

1. **Files** (Dataset Sources page): the 9 Olist CSVs in `DATASET_DIR` or uploaded (streamed, size-limited, only the 9
   known names, `text/csv`). Scan: SHA-256, record counts, header check (any order, case-insensitive; the real files
   spell `product_name_lenght`), dry-run validation. Preview: mapping and first rows with per-field errors. Show that
   nothing is bundled and why (licence, listed as CC BY-NC-SA 4.0 on Kaggle — verify); offer the synthetic fixture
   generator (`scripts/make-olist-fixture.js`) for trying the flow, clearly labelled synthetic.
2. **Staging:** the streaming RFC 4180 parser (quotes, embedded line breaks, BOM, CRLF, multi-byte characters across
   chunks, **bounded field length even inside an unterminated quote**) feeds typed rows into `STG_OLIST_*` with
   `executeMany`, one unit per transaction with its ledger row; resume refuses changed files; rejects counted by
   reason, up to 50 per unit sampled into `STG_IMPORT_REJECTS`. Empty CSV fields become NULL (Oracle would do so
   anyway; make it explicit).
3. **Integrity report:** 18 cross-file checks (orders without items, unknown products, products sold by several
   sellers, zip prefixes missing from geolocation, deliveries before pickup, ...), each with the transform's action.
4. **Transform** into lab tables with the same ledger/retry/resume; requires empty lab tables; every repair counted
   (approval missing or before purchase, delivery before pickup, delivered without date → shipped, reviews before
   delivery, payments not summing to the total → difference on the last payment, zero/`not_defined` payments,
   unknown products, orders without items skipped). `MAP_OLIST_IDS` maps 32-hex ids to lab ids via
   `ROW_NUMBER()` over a stable order. Missing attributes are synthesized deterministically from seed and lab id.
5. **Calibration profile** from staging (category mix with median prices, payment mix, state shares, basket size,
   review coverage) → "Open in Data Generator" → "Apply scale"; stored in the job's configuration snapshot.

## 11. Validation (27 business rules)

Each rule is a SQL query returning violating keys (sample of offenders shown), run with a call timeout, as a job:

`orphans`, `orders_have_items`, `products_in_leaf_categories`, `seller_before_product`, `product_before_purchase`,
`customer_before_purchase`, `order_subtotal`, `payment_total`, `payment_status`, `refund_not_exceeding_capture`,
`shipment_cost`, `promotion_redemption`, `item_seller_shipment`, `shipment_after_approval`, `shipment_destination`,
`delivered_consistency`, `shipped_consistency`, `canceled_not_shipped`, `tracking_sequence`,
`reviews_after_delivery`, `returns_after_delivery`, `return_quantity`, `return_refund_amount`, `inventory_balance`,
`sales_match_shipments`, `zip_consistency`, `converted_carts`.

Plus a realism profile (status mix, payment mix, ratings, top states, repeat rate, late-delivery rate, average
delivery time, return rate) and `sql/verification/verify_generated_data.sql`.

Oracle notes: use `LAG()` / `MATCH_RECOGNIZE` where they read the data once; prefer set-based anti-joins (`NOT
EXISTS`); check every rule's plan at Large and XL scale (hash joins and full scans are usually right for whole-table
validation; a nested loop over an index on 15M rows is the MariaDB lesson in section 21). Long validation queries
on data that is still changing can hit `ORA-01555`; validation runs only when no data job is active.
An integration test corrupts rows inside a rolled-back transaction to prove every rewritten rule still detects
violations.

## 12. Table Explorer

- Tables grouped by layer with estimated counts (labelled with `LAST_ANALYZED`) and an **Exact count** button
  (`COUNT(*)` with a 60 s call timeout).
- Structure from `ALL_TAB_COLUMNS`, `ALL_CONSTRAINTS`, `ALL_CONS_COLUMNS`, `ALL_INDEXES`, `ALL_IND_COLUMNS`,
  `ALL_TRIGGERS`; DDL via `DBMS_METADATA.GET_DDL` (session transform params to omit storage clauses).
- Data: explicit column lists, long text truncated server-side (`DBMS_LOB.SUBSTR` for CLOBs), ≤ 200 rows per page,
  15 s call timeout, **keyset pagination** on the primary key or (sort column, primary key) with explicit
  `NULLS FIRST/LAST` in both directions (Oracle defaults differ for ASC and DESC), `FETCH FIRST :n ROWS ONLY`.
  No `OFFSET` in the explorer.
- Up to 5 filters (column from the dictionary allow-list, operator from an allow-list, bound value); `LIKE :v ESCAPE
  '\'` with wildcards escaped; case-insensitive search via `UPPER(col) LIKE UPPER(:v)` only on indexed or small
  tables, otherwise explain why it is refused.
- Sorting a table above 1M rows by a column no index starts with is refused, with an explanation.
- Each page shows its plan: `EXPLAIN PLAN SET STATEMENT_ID = :id FOR <fixed sql>` then
  `DBMS_XPLAN.DISPLAY('PLAN_TABLE', :id, 'TYPICAL')`; warn on `TABLE ACCESS FULL` of large tables.
- "Count matching rows" capped at 100,000 (`COUNT(*)` over `FETCH FIRST 100001 ROWS ONLY`).
- Relationships: parents (links) and children with bounded counts; FK cells link to the parent row.

## 13. Database object catalog (Schema Designer → Database objects)

One SQL file per object under `sql/objects/<type>/` with `-- key: value` headers (purpose, depends, example). Applied
by the owner after typed confirmation, in dependency order; removable only when no dependant exists
(`USER_DEPENDENCIES`); every apply/remove recorded as a job; examples run with the runtime account (bounded) and
data-changing examples need confirmation. After applying, show `USER_OBJECTS.STATUS` and `USER_ERRORS` for anything
`INVALID`.

| Type | Objects (Oracle form) |
|---|---|
| Views | `V_ORDER_SUMMARY`, `V_INVENTORY_STATUS`, `V_MONTHLY_CATEGORY_REVENUE`, `V_CUSTOMER_LIFETIME`, `V_SELLER_PERFORMANCE` (mergeable / predicate-pushdown friendly; document which the optimizer merges) |
| Functions | `FN_ORDER_BALANCE`, `FN_DELIVERY_DAYS`, `FN_STOCK_BALANCE` (PL/SQL, `AUTHID CURRENT_USER` where it reads data; consider `RESULT_CACHE` / `DETERMINISTIC` and explain the trade-off) |
| Procedures | `SP_REFRESH_SALES_SUMMARIES` (`MERGE`), `SP_RECALCULATE_INVENTORY`, `SP_CUSTOMER_ORDERS` (returns `SYS_REFCURSOR`), `SP_ORDER_HEALTH` — optionally grouped in a package `PKG_LAB` |
| Triggers | `TRG_RETURN_ITEMS_QTY_GUARD`, `TRG_REVIEWS_DELIVERED_GUARD`, `TRG_ORDERS_STATUS_TRANSITION`, `TRG_ORDERS_STATUS_HISTORY` (writes `ORDER_STATUS_HISTORY`). Row triggers must not query their own table (`ORA-04091` mutating table); use compound triggers or check the parent table instead. Measure the cost on generation (MariaDB: Small preset 6.6 s with triggers vs 5 s without). |
| Scheduler jobs (instead of MariaDB events) | `JOB_REFRESH_SALES_SUMMARIES` via `DBMS_SCHEDULER.CREATE_JOB` (hourly), owned by the lab schema. It runs only while `job_queue_processes > 0`; the page reads the parameter and explains, never changes it. |
| Materialized views (new) | `MV_DAILY_SALES` / `MV_MONTHLY_CATEGORY` with MV logs and `REFRESH FAST ON DEMAND`, compared with the summary tables (refresh time, staleness, query time). |
| Indexes | Each names the query it serves and shows its plan before/after: `IX_INV_MOV_TIME_TYPE` (covering for the stock chart), `IX_ORDER_ITEMS_PRODUCT_SALES` (covering revenue per product), `IX_CUSTOMERS_NAME_UPPER` (function-based on `UPPER(last_name)` for prefix search). Bitmap examples only on editions that support them. |
| Sequences | Shown for completeness (identity columns create them); cache size and ordering explained (`NOORDER` on RAC). |

## 14. Partitioning lab

Enabled only when `V$OPTION` reports Partitioning **and** the licence is confirmed (rule in section 2). Builds
`EXP_ORDERS_PARTITIONED`, a **separate copy** of `ORDERS`:

- `PARTITION BY RANGE (PURCHASED_AT) INTERVAL (NUMTOYMINTERVAL(1,'MONTH'))` (month/quarter/year choices), or explicit
  ranges with a `MAXVALUE` partition; show the DDL and a rule checklist first.
- Oracle allows a primary key that does not contain the partition key (global index) — explain local vs global
  indexes, and what partition maintenance (`DROP/TRUNCATE PARTITION ... UPDATE INDEXES`) does to each.
- Foreign keys **are** possible on partitioned tables in Oracle (unlike InnoDB); keep the copy without FKs anyway so it
  stays independent, and say so.
- Rows copied in resumable units (job). Validate every input (e.g. `commitInterval`) **before** any DDL.
- **Comparison:** the same queries on both tables with `EXPLAIN PLAN` (`PARTITION RANGE SINGLE/ITERATOR/ALL`,
  `Pstart/Pstop`) and median timings, identical results checked: a date-range aggregate (pruned) and a lookup by
  `ORDER_ID` alone (local index ⇒ probes every partition; global index ⇒ one probe).
- The transactional tables are never partitioned. Drop of the experiment table only, after confirmation.

## 15. Visual Analytics

13 native SVG charts from live queries, one filter row (date presets, category or category group, seller, status,
region) applied to every chart and the KPI tiles:

daily sales, monthly revenue, revenue by category, top 10 products (aggregate by product id first, then join names),
orders by status, payment methods, customer geography, hour × weekday heatmap, delivery-duration histogram (median,
p90, late share), cancellation and return rates, repeat-purchase share, inventory in/out, insertion throughput of
the latest job.

- Without category/seller/status/region filters, sales charts read the summary tables (or the materialized views when
  installed); otherwise the fact tables over the indexed purchase-date range. Every card shows its source and query
  time and lists filters that do not apply. Each chart query runs with a call timeout and a concurrency cap.
- Accessibility and design: hover and keyboard tooltips, legend for ≥ 2 series, a table view for every chart,
  validated colour-blind-safe palettes for light and dark mode, previous render held at reduced opacity while
  refetching, no dual axes.

## 16. Performance Lab

13 scenarios as in MariaDB Data Lab — read scenarios on lab tables, **write scenarios only on `BENCH_EVENTS`**
(emptied before and after) — plus Oracle-specific ones:

| Scenario | Operation |
|---|---|
| Bulk INSERT | `executeMany` array DML (rows per batch configurable) |
| Single-row INSERT | one insert + commit per operation |
| SELECT by primary key | point lookup on `ORDERS` |
| Indexed filtering | latest 20 orders of a customer (`FETCH FIRST 20 ROWS ONLY` on the index) |
| Full-table scan | aggregate with a predicate on an unindexed column (`full-scan` with concurrency > 2 is heavy) |
| Aggregation / GROUP BY | status breakdown over a random date window |
| Multi-table JOIN | orders × customers × items × products for 50 orders |
| Concurrent reads | mix of the three read shapes |
| Concurrent writes | inserts + PK updates (configurable share) |
| Mixed read/write | configurable read share |
| Commit throughput | N inserts + 1 update + `COMMIT` (redo/`log file sync` bound) |
| Pagination | `OFFSET :o ROWS FETCH NEXT :n ROWS ONLY` vs keyset; reported per variant |
| Analytical | monthly revenue by category over a year of fact data |
| *Oracle extra:* Array size | the same read with different `fetchArraySize` / `prefetchRows` (round trips) |
| *Oracle extra:* Direct-path insert | `INSERT /*+ APPEND_VALUES */` with `executeMany` into `BENCH_EVENTS` (heavy; explain `ORA-12838` and logging/locking implications) |
| *Oracle extra (optional, heavy):* Bind vs literal | identical statements with server-generated integer literals vs binds, showing hard parses (`V$SYSSTAT 'parse count (hard)'`); capped iterations, typed confirmation, never against shared/production servers |

**How a run works:** concurrency, duration or iterations, warm-up (not measured), per-call timeout, seed, label,
scenario parameters; a dedicated pool per run; heavy runs (concurrency, duration, iterations, rows written,
concurrent full scans) need typed confirmation; every mode has a wall-clock cap; cancellation keeps partial results;
errors and timeouts are counted separately.

**What is measured:** log-linear latency histogram (≈ 1% error) with min/mean/p50/p90/p95/p99/p99.9/max, ops/s,
rows/s, per-variant latency, per-second timeline, deltas of `V$SYSSTAT` (session logical reads, physical reads, redo
size, user commits, parse counts, executes) and `V$SYSTEM_EVENT` (top waits during the run), buffer cache hit ratio
during the run. **Environment snapshot** per run: version and edition, CDB/PDB, `cpu_count`, `sga_target`/
`memory_target`, `db_cache_size`, `pga_aggregate_target`, `db_block_size`, `commit_logging`/`commit_wait`,
`filesystemio_options`, `disk_asynch_io`, `optimizer_features_enable`, archive log mode, statistics freshness of the
tables involved, data volume, client details. **Compare** up to 8 runs, warning when environments differ.

**Live SQL view:** the configuration form lists each scenario's statements, and the Live run panel shows, per
variant, the last executed statement with its bind values inlined **for display only**, its latency and measured
count, refreshed every second; statement text and executed SQL come from the same constants. The final snapshot is
taken after the worker loop ends so per-variant counts add up to the total.

Never `ALTER SYSTEM FLUSH BUFFER_CACHE` for "cold" runs; document how a DBA could do it on a private server instead.

## 17. SQL Diagnostics (read-only)

Auto-refresh every 5 s, rates computed only over intervals ≥ 1 s. Default (no pack) sources:

- Overview: version, instance, uptime (`V$INSTANCE.STARTUP_TIME`), sessions vs `sessions`/`processes` limits.
- Workload rates from `V$SYSSTAT`: user calls, executes, commits, rollbacks, logical and physical reads, redo size,
  parse counts (hard/total); history chart.
- Buffer cache: hit ratio (interval and since startup), `V$SGASTAT`, `V$PGASTAT`.
- Top wait events (interval deltas of `V$SYSTEM_EVENT`, excluding the `Idle` class).
- Active sessions and blockers (`V$SESSION` with `BLOCKING_SESSION`, `EVENT`, `SQL_ID`, `SECONDS_IN_WAIT`), open
  transactions (`V$TRANSACTION` with undo blocks), long operations (`V$SESSION_LONGOPS`).
- Top SQL by elapsed time from `V$SQLSTATS` (text truncated), with `DBMS_XPLAN.DISPLAY_CURSOR` on click.
- Redo: log groups and sizes (`V$LOG`), log switches per hour (`V$LOG_HISTORY`), archive mode.
- Undo (`V$UNDOSTAT`: max query length, `SSOLDERRCNT` = ORA-01555 count), temp usage (`V$TEMPSEG_USAGE`).
- Tablespace usage (`DBA_TABLESPACE_USAGE_METRICS` or `USER_TS_QUOTAS` without dictionary access).
- Largest lab segments, statistics freshness, invalid objects in the lab schema, the app's own pool.
- **Only with the Diagnostics Pack confirmed:** ASH top activity of the last 15 minutes and AWR snapshot list; each
  such panel states the licence requirement. Every unavailable section says why (privilege, edition, licence) and
  what a DBA could grant.

## 18. Server Assessment (read-only, any database)

Works without the lab schema, with the assessment (or admin) account; one dedicated connection with a call timeout;
one assessment at a time.

**Collected:**

- **Instance and database:** version banner, edition, platform, `V$INSTANCE` (host, instance name, status, startup),
  `V$DATABASE` (name, DBID, role, open mode, `LOG_MODE`, `FORCE_LOGGING`, `FLASHBACK_ON`, protection mode, CDB),
  character sets (`NLS_DATABASE_PARAMETERS`), time zone file version, components (`DBA_REGISTRY`), options
  (`V$OPTION`), patches (`DBA_REGISTRY_SQLPATCH`).
- **Topology:** RAC (`cluster_database`, `GV$INSTANCE` — every instance, status, host), Data Guard
  (`DATABASE_ROLE`, `V$DATAGUARD_STATS` transport/apply lag, `V$ARCHIVE_DEST_STATUS`, `V$DATAGUARD_CONFIG`),
  multitenant (`V$PDBS` / `V$CONTAINERS`: name, open mode, restricted, size). Topology label e.g. "RAC 2 instances ·
  Data Guard primary · CDB with 3 PDBs".
- **Parameters:** every row of `V$PARAMETER` (value, `ISDEFAULT`, `ISMODIFIED`, `ISSES_MODIFIABLE`,
  `ISSYS_MODIFIABLE`, `ISDEPRECATED`, description) plus `V$SPPARAMETER` (what is in the spfile), filtered to
  non-default by default; on RAC show per-instance differences (`GV$PARAMETER`).
- **Statistics:** all of `V$SYSSTAT`, `V$SYSTEM_EVENT` top waits since startup, `V$OSSTAT`, SGA/PGA breakdown.
- **Storage:** tablespaces (type, status, bigfile, autoextend, used/max, `DBA_TABLESPACE_USAGE_METRICS`), data files,
  temp files, redo groups and switch rate, archive destination usage (`V$RECOVERY_FILE_DEST`), undo retention.
- **Schemas:** every non-Oracle-maintained user (`DBA_USERS.ORACLE_MAINTAINED = 'N'`) with object counts by type,
  segment size, account status, profile, default tablespace — never password data.
- **Tables:** per table (largest 20,000; totals always exact): owner, name, rows (stats), blocks, segment size,
  `LAST_ANALYZED`, stale stats (`DBA_TAB_STATISTICS.STALE_STATS`), partitioned, compression, logging, row movement,
  temporary, IOT, PK present, index and FK counts, FKs without an index.
- **Security posture (names and flags only):** users with default passwords (`DBA_USERS_WITH_DEFPWD`), open accounts
  with expired/grace passwords, grants of `DBA`/`ANY` privileges to non-Oracle users, `PUBLIC` grants on sensitive
  packages (`UTL_FILE`, `UTL_HTTP`, `DBMS_SQL` ...), unified audit status, `remote_login_passwordfile`.
- **Backups:** last successful full/incremental/archivelog backup (`V$RMAN_BACKUP_JOB_DETAILS`), block corruption
  (`V$DATABASE_BLOCK_CORRUPTION`).
- **Feature usage** (`DBA_FEATURE_USAGE_STATISTICS`) shown as information for licence review, clearly labelled as
  "detected usage, not a licence audit".

**Findings** (severity critical/warning/info, evidence, recommendation, conventional thresholds, sorted by severity):
`NOARCHIVELOG` on a non-dev database; no successful backup in N days; tablespace > 85% of max and not autoextensible;
stale or missing statistics; invalid objects; unusable indexes; tables without PK; FK columns without an index;
Data Guard transport/apply lag; standby not applying; RAC instance down; redo switches > 4/hour sustained (redo too
small); `ORA-01555` count > 0; sessions/processes near the limit; buffer cache hit ratio low with high physical reads;
users with default passwords; `DBA`/`ANY` grants to application users; `PUBLIC` execute on risky packages; deprecated
parameters set; `FORCE_LOGGING` off on a Data Guard primary; non-`AL32UTF8` character set; short uptime (counters
cover little time); truncated table list.

**Redaction:** values of parameters whose names end in a secret word (`_password`, `_passwd`, `_secret`, `_token`,
`_key` when it is a value, not a path) are shown as `***`, with an explicit allow-list for policy parameters that only
look secret; unit-tested for false positives (MariaDB lesson: `max_password_errors` and `secure_auth` were wrongly
masked at first). An integration test asserts that no configured password appears anywhere in the assessment.

**Exports:** self-contained HTML report (printable to PDF, every value escaped), full JSON, CSV per dataset
(findings, parameters, statistics, waits, tablespaces, schemas, tables, RAC instances, Data Guard, PDBs) with a UTF-8
BOM and formula-injection protection (`= + - @` prefixed with `'` unless numeric). Exports contain host names, paths
and service names: label them internal.

**UI:** tabs Summary · Findings · Topology (RAC / Data Guard / PDBs) · Storage · Schemas · Tables · Parameters ·
Statistics & waits; long values wrap, value columns are left-aligned and start next to the name column.

## 19. Security (carry over everything from MariaDB Data Lab Phase 5)

- Bind to `127.0.0.1` by default; refuse to start on a network address without a token ≥ 16 characters; constant-time
  token comparison; token in `sessionStorage` only.
- Every API call except `/api/health` needs `X-DataLab-Request: 1` (blocks cross-site forms, images, scripts);
  reject `Sec-Fetch-Site: cross-site`, foreign `Origin`, and `Host` names outside the allow-list (DNS rebinding, 421).
- JSON bodies only (415), ≤ 1 MiB (413), connection closed after 413/415 (an unread body must not become the next
  request); capture `req.socket` before the response finishes.
- Concurrency caps (429) on expensive endpoints: connection test, SSE streams, uploads, previews, staging report, row
  counts, browsing, partition comparison, charts, object examples, diagnostics, assessment.
- Strict headers: CSP `default-src 'self'` without inline script/style, `frame-ancestors 'none'`, `X-Frame-Options:
  DENY`, `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP `same-origin`, restrictive `Permissions-Policy`.
- Static files only from `public/`, decoded, NUL-rejected, normalized and prefix-checked.
- DOM built with `textContent`, never `innerHTML` with data.
- `Object.hasOwn` for every lookup keyed by user input (`__proto__`, `constructor` must be rejected).
- Driver: TLS server DN match on; never log connect strings with credentials; error messages stripped of SQL.
- `docs/SECURITY.md`: threat model, controls, review log, operator checklist; `npm audit` clean.

## 20. Delivery plan

Build in phases. Each phase ends end-to-end working, tested, documented, with an honest status (what was verified,
on which edition/version, what was not).

**Phase 1 — foundation.** HTTP app with the full security layer, Connections (diagnostics, privileges check, licence
settings), DBA scripts, schema apply (marker, conflicts, shared-schema opt-in, grants), generator Small→XL with the
job engine (ledger, resume, retries, pause/cancel, SSE), validation (27 rules), cleanup, job history, overview KPIs.
*Acceptance:* Small and Medium generate and validate with 0 violations; resume after kill produces identical content
hashes; same seed with 1 and 4 workers identical; cleanup leaves constraints enabled.

**Phase 2 — import.** Dataset Sources, uploads, scan/preview, staging with resume, integrity report, transform with
repair statistics, calibration and scaled generation, Large (10M) run with measured numbers.
*Acceptance:* fixture import passes all rules; a failed unit resumes exactly once; transform deterministic.

**Phase 3 — explore and model.** Table Explorer, object catalog (incl. scheduler job and materialized views),
partitioning lab (licence-gated), Visual Analytics (13 charts).
*Acceptance:* keyset visits every row exactly once in both directions with NULL sort keys; every catalog object
applies, is `VALID`, and is removable in dependency order; summary and fact paths agree.

**Phase 4 — performance and diagnostics.** Performance Lab (all scenarios, live SQL view, environment snapshot,
compare), SQL Diagnostics (free views; pack-gated panels).
*Acceptance:* write scenarios leave business tables unchanged and `BENCH_EVENTS` empty; iteration mode runs exactly
N operations; heavy runs need confirmation; pack-licensed views are never queried without confirmation (test asserts
it by inspecting executed SQL).

**Phase 5 — hardening, assessment, scale.** Security review and fixes, HTTP-level tests, Server Assessment with
exports, XL run on a licensed test server (or the largest preset that fits), validation tuning at scale, docs.
*Acceptance:* assessment never leaks passwords; findings unit-tested on synthetic states (RAC, Data Guard, PDBs,
stale stats, default passwords); all suites green.

**Tests:** unit (no database: PRNG, generator rules, determinism, config validation, injection rejection, CSV parser
incl. every chunk split, HTTP security, histogram accuracy, assessment findings/redaction/exports) and integration
(against `DATALAB_TEST` in the dev container; skipped if unreachable). Target at least the MariaDB counts (70 unit,
37 integration) with equivalent coverage.

**Docs:** README (quick start with the Free container, configuration, every feature, measured results with the
environment, troubleshooting by ORA- code, API), `docs/ERD.md`, `docs/PERMISSIONS.md`, `docs/SECURITY.md`,
`docs/LICENSING.md` (which feature needs which option/pack and how the app gates it), `datasets/README.md`.

## 21. Lessons learned from MariaDB Data Lab (avoid repeating them)

| What happened in MariaDB Data Lab | Rule for OracleDB Data Lab |
|---|---|
| Customer concentration and repeat rate were unrealistic until first-purchase permutations and bucketed Zipf ranks were used; shifting order dates distorted monthly growth (re-pick the customer instead). | Port the tuned generator unchanged; keep its distribution tests. |
| Concurrent `INSERT ... SELECT` into an auto-increment table failed (`ER_AUTOINC_READ_FAILED`). | No multi-worker `INSERT ... SELECT` into the same table; read without locks, write in bulk. Identity/sequence `CACHE 1000`, `NOORDER` on RAC. |
| A closure read a variable before initialization (TDZ) when launching validation. | Pass state explicitly to launchers; unit-test job launchers. |
| Shell escaping corrupted code (template literals, a regex `\b` became a backspace). | Write files with an editor/file tool, never through shell heredocs; scan the tree for control characters in CI. |
| Reserved words used as aliases (`reads`, `lines`) broke queries. | Check every identifier and alias against `V$RESERVED_WORDS` in an integration test. |
| Events were invisible to the runtime account. | Read scheduler/dictionary state with the owner or assessment account; never assume `ALL_*` shows everything. |
| A "top products" chart took 10 s; aggregating by id first then joining names took 2.8 s. | Aggregate on keys first, join descriptive columns last; check plans at Large scale. |
| The partition experiment validated input after running DDL. | Validate everything before the first DDL or write. |
| Rates over sub-second intervals and after host sleep were absurd (36M rows/s). | 30 s window that keeps one sample at the edge; ≥ 1 s intervals for diagnostics; unit-test with a fake clock. |
| Validation at 50M rows: one rule timed out (300 s), others took 150–200 s, because the optimizer walked a smaller secondary index and turned joins into random I/O. Rewrites (force PK order, aggregate in key order) cut 26 min to 14.5 min. | Review every validation plan at XL scale; prefer hash joins/full scans for whole-table checks; add an integration test that corrupts rows (rolled back) to prove rewrites still detect violations. |
| Throughput fell from ~75K to ~15–25K rows/s once data outgrew the 512 MiB buffer pool. | Report memory vs data size before XL; document SGA sizing; keep optional indexes/triggers off during bulk loads. |
| After a 413 the unread body poisoned the keep-alive connection; a `finish` handler crashed on a null socket. | `Connection: close` + destroy after 413/415; capture the socket first; HTTP tests for it. |
| Prototype keys (`__proto__`, `constructor`) resolved as presets/scenarios. | `Object.hasOwn` everywhere; tests with those names. |
| Iteration-mode benchmarks bypassed heavy-run confirmation and had no time cap. | Heavy rules cover concurrency, duration, iterations and rows written; every mode has a wall-clock cap. |
| An unterminated CSV quote could buffer a whole file into one field. | Bound field length during accumulation. |
| A stored password could be sent to a newly entered host. | Re-enter passwords for any endpoint/user/TLS change. |
| Two simultaneous job starts both passed "one job at a time". | Reserve the start slot synchronously. |
| Installing into an existing schema: unrelated tables blocked the install with no way forward, and a same-named user table could have been adopted (and later truncated). | Name-conflict refusal, explicit shared-schema opt-in, marker written early, external-FK check before cleanup, clear UI reason next to a disabled button. |
| Pages returned 502 "Database operation failed" when the schema was not installed. | Map "table or view does not exist" (`ORA-00942`) to 409 with "install the schema" guidance. |
| The connection override lived only in memory and was lost on every restart. | Decide up front (section 23): keep in-memory (secure) and say so in the UI, or persist the profile **without** passwords. |
| Assessment redaction masked harmless settings. | Precise suffix patterns + allow-list + unit tests for both directions. |
| A server time without time zone made the "started at" wrong by the client's offset. | Compute instants server-side from UTC (`SYS_EXTRACT_UTC(SYSTIMESTAMP)`); send ISO strings with `Z`. |
| Live per-variant counts missed operations finished after the last tick. | Take a final snapshot after the worker loop. |
| Long values (wsrep options, 1.8K characters) and right-aligned value columns pushed data off-screen. | Value columns wrap and are left-aligned next to a content-width name column; check tables at 1000 px and 390 px. |
| Mobile overflow from fixed grid minimums. | `minmax(0, 1fr)` grids, `min(100%, …)` form columns, verify at 390 px. |
| Integration tests can hang on keep-alive connections. | `server.closeAllConnections()` in test teardown; pools closed in `after()`. |
| Measured results were sometimes over-generalized in docs (e.g. "about a second on a typical server"). | Report only what was measured, with the environment; say what was not verified. |
| Browser automation must not touch the user's own browser. | Spawn a dedicated headless browser with its own profile and close it via CDP; never kill browser processes by name. |

## 22. MariaDB → Oracle cheat sheet

| Concern | MariaDB Data Lab | OracleDB Data Lab |
|---|---|---|
| Driver | `mariadb` (`?` placeholders, `batch()`) | `oracledb` Thin (`:name` binds, `executeMany()` with `bindDefs`) |
| Schema | database (`CREATE DATABASE`) | user/schema created by the DBA script |
| Statement timeout | `SET STATEMENT max_statement_time = n FOR ...` | `connection.callTimeout` (ms); drop the connection after a timeout |
| Auto ids | `AUTO_INCREMENT` | explicit ids; identity `GENERATED BY DEFAULT ON NULL AS IDENTITY`; resync with `START WITH LIMIT VALUE` |
| Booleans / JSON | `TINYINT(1)` / `JSON` | `NUMBER(1)` + CHECK / `CLOB IS JSON` (19c), native on 21c+/23ai |
| Empty string | distinct from NULL | **is NULL** |
| Paging | `LIMIT n OFFSET m` | `OFFSET m ROWS FETCH NEXT n ROWS ONLY`; keyset with explicit `NULLS FIRST/LAST` |
| Upsert | `INSERT ... ON DUPLICATE KEY UPDATE` | `MERGE INTO` |
| Idempotent DDL | `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE` | 23ai `IF NOT EXISTS`; 19c: catch `ORA-00955` & co.; `CREATE OR REPLACE` for views/PLSQL/triggers |
| Truncate parents | `foreign_key_checks = 0` for the session | disable the lab's FKs, truncate child→parent, re-enable `VALIDATE` |
| Events | `CREATE EVENT`, `event_scheduler` | `DBMS_SCHEDULER` jobs, `job_queue_processes` |
| Summary refresh | procedure + event | `MERGE` procedure + scheduler job, or materialized views (fast refresh with MV logs) |
| Triggers | BEFORE/AFTER row triggers | same, beware `ORA-04091` mutating table; compound triggers |
| Routine security | `SQL SECURITY INVOKER` | `AUTHID CURRENT_USER` |
| Plans | `EXPLAIN`, `EXPLAIN PARTITIONS` | `EXPLAIN PLAN FOR` + `DBMS_XPLAN.DISPLAY`; `DISPLAY_CURSOR(sql_id)` |
| DDL text | `SHOW CREATE TABLE` | `DBMS_METADATA.GET_DDL` |
| Row estimates | `information_schema.TABLES.TABLE_ROWS` | `USER_TABLES.NUM_ROWS` after `DBMS_STATS` |
| Partitioning | free; PK must include partition column; no FKs | **licensed option on EE**; global/local indexes; FKs allowed; interval partitioning |
| Status counters | `SHOW GLOBAL STATUS` | `V$SYSSTAT`, `V$SYSTEM_EVENT`, `V$OSSTAT` |
| Parameters | `information_schema.SYSTEM_VARIABLES` | `V$PARAMETER`, `V$SPPARAMETER`, `GV$PARAMETER` |
| Processlist / locks | `information_schema.PROCESSLIST`, `INNODB_TRX` | `V$SESSION` (`BLOCKING_SESSION`), `V$TRANSACTION`, `V$LOCK` |
| Statement digests | `performance_schema` | `V$SQLSTATS` (free); ASH/AWR only with Diagnostics Pack |
| Buffer pool | `innodb_buffer_pool_size`, `Innodb_buffer_pool_reads` | SGA / `db_cache_size`, `physical reads` vs `session logical reads` |
| Durability knobs (read-only) | `innodb_flush_log_at_trx_commit`, `sync_binlog` | `commit_logging`, `commit_wait`, archive log mode, `FORCE_LOGGING` |
| Cluster / replication | Galera (`wsrep_*`), async replicas (`SHOW ALL SLAVES STATUS`) | RAC (`GV$`), Data Guard (`V$DATAGUARD_STATS`), multitenant (`V$PDBS`) |
| Deadlock / lock wait codes | 1213 / 1205 | `ORA-00060` / `ORA-00054`, `ORA-30006` |
| Lost connection | 2006 / 2013 | `ORA-03113`, `ORA-03114`, `ORA-03135` |
| Missing table | 1146 | `ORA-00942` |
| Dev server | MariaDB 11.4 in Docker | Oracle Database 23ai Free container (PDB `FREEPDB1`) |

## 23. Decisions to settle before building

1. **Target versions:** 19c + 23ai (recommended: develop on 23ai Free, CI-test the 19c fallbacks), or 23ai only.
2. **Licensing context:** which packs/options are licensed on the servers the lab will touch (defaults: none).
3. **Accounts:** confirm the three-account model and that the DBA script, not the app, creates users.
4. **Container sizing:** Free's caps limit the largest preset; decide which licensed test server (if any) runs XL.
5. **Code sharing:** copy the database-agnostic modules from MariaDB Data Lab, or extract them into a shared package
   used by both labs (no build step either way).
6. **Connection override persistence:** in-memory only (current behaviour, lost on restart) or persisted without
   passwords.
7. **Dataset:** reuse the Olist import (same licence caveats) or add an Oracle sample schema (e.g. `SH`/`CO` from
   Oracle's db-sample-schemas, checking its licence) as an additional reference.
