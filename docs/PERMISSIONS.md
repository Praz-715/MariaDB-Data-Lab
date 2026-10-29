# Database permissions

The application uses two accounts so that day-to-day traffic cannot change the schema.

| Account | Env vars | Used for |
|---|---|---|
| Runtime | `DB_USER`, `DB_PASSWORD` | All reads, generation inserts, validation, job bookkeeping |
| Administrative | `DB_ADMIN_USER`, `DB_ADMIN_PASSWORD` | `CREATE DATABASE`, `CREATE TABLE`, cleanup (`TRUNCATE`) |

If no admin account is configured, the runtime account is used for everything and therefore needs the admin
grants too. That is acceptable on a disposable test server only.

## Recommended grants

Replace `datalab` with your `DB_NAME`, and `'%'` with the application host if you can.

```sql
-- Administrative account: DDL on the lab schema only.
CREATE USER 'datalab_admin'@'%' IDENTIFIED BY '<strong password>';
GRANT CREATE, ALTER, DROP, INDEX, REFERENCES,
      SELECT, INSERT, UPDATE, DELETE,
      CREATE VIEW, SHOW VIEW, TRIGGER, CREATE ROUTINE, ALTER ROUTINE, EVENT, EXECUTE
   ON `datalab`.* TO 'datalab_admin'@'%';

-- Runtime account: DML on the lab schema, plus EXECUTE to call the lab's routines.
CREATE USER 'datalab_app'@'%' IDENTIFIED BY '<another strong password>';
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON `datalab`.* TO 'datalab_app'@'%';
```

Notes:

- Database-level `CREATE` on `datalab`.* is enough for the admin account to run `CREATE DATABASE datalab`; no
  global privileges are needed.
- `DROP` is needed only because MariaDB implements `TRUNCATE TABLE` with the `DROP` privilege. The application
  never issues `DROP TABLE` or `DROP DATABASE`.
- View, routine, trigger and event privileges let the admin account install the database object catalog
  (Schema Designer → Database objects). Views and routines are created with `SQL SECURITY INVOKER`, so they run
  with the caller's privileges; triggers and events always run as their definer (the admin account).
- `EXECUTE` on the runtime account is needed to call the catalog functions and procedures (examples, analytics
  users). Without it, everything else still works.
- `information_schema.EVENTS` only lists events to accounts with the `EVENT` privilege, so the application reads
  event status with the admin account.
- The application never runs `SET GLOBAL`. Enabling `event_scheduler` is left to a DBA.
- SQL Diagnostics works without extra grants, but shows more with two optional, read-only grants:

  ```sql
  GRANT PROCESS ON *.* TO 'datalab_app'@'%';                     -- all sessions, open transactions, lock waits
  GRANT SELECT ON performance_schema.* TO 'datalab_app'@'%';     -- statement digests, table I/O
  ```

  Without them, the affected sections say what is missing. `PROCESS` lets the account see every session's
  current statement, so grant it only where that is acceptable.
- The Performance Lab uses the runtime account. Write scenarios need `INSERT`/`UPDATE` on `bench_events` (covered
  by the schema-level DML grant); the table is emptied with the admin account (`TRUNCATE`).
- The integration tests use a second schema, `datalab_test`, which needs the same grants.

## Server Assessment

The assessment reads with the admin account (the runtime account when no admin account is set). Everything is
read-only. It works with the lab grants alone, but then only sees the lab schemas and cannot read replication
state. For a full assessment of a server, use a dedicated read-only account:

```sql
CREATE USER 'assessor'@'%' IDENTIFIED BY '...';
GRANT SELECT, SHOW VIEW ON *.* TO 'assessor'@'%';            -- every schema's tables and views in information_schema
GRANT SLAVE MONITOR ON *.* TO 'assessor'@'%';                -- SHOW ALL SLAVES STATUS (MariaDB 10.5.9+)
GRANT BINLOG MONITOR ON *.* TO 'assessor'@'%';               -- SHOW MASTER STATUS (MariaDB 10.5.2+)
GRANT REPLICATION MASTER ADMIN ON *.* TO 'assessor'@'%';     -- SHOW SLAVE HOSTS (MariaDB 10.5.2+)
```

On MariaDB before 10.5, `REPLICATION CLIENT` covers the replica and binary log status. `SELECT ON *.*` lets the
account read table data, not just metadata; if that is not acceptable, grant `SHOW VIEW` and object-level
privileges only, and accept that some schemas are missing from the inventory. Enter the account on the Connections
page (as runtime and admin user) for the duration of the assessment.

## Verifying

The Connections page shows `SHOW GRANTS FOR CURRENT_USER()` for the runtime account after a successful test.
