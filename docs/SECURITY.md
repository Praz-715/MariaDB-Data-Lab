# Security model

MariaDB Data Lab is a single-operator tool for **non-production** MariaDB servers. It holds database
credentials, can create and empty tables in its lab schema, and can put sustained load on the server. This
document describes what it protects against, how, and what remains the operator's responsibility.

## Assets and trust boundaries

| Asset | Where it lives | Who may use it |
|---|---|---|
| Runtime and admin database passwords | `.env` or server memory (Connections page) | The Node.js process only |
| Lab schema data and objects | MariaDB, schema `DB_NAME` | The app, through fixed SQL |
| Destructive operations (schema apply, cleanup, staging clear, object removal, partition experiment) | API endpoints | The operator, after explicit confirmation |
| Server capacity (CPU, I/O, connections) | MariaDB host | Bounded by limits and confirmations |

Trust boundaries: the **browser** (untrusted input, possibly a malicious page in another tab), the **network**
between browser and server, and the **MariaDB server** (trusted, but its error messages are not shown verbatim).

## Threats and controls

### Other web sites in the same browser (CSRF, DNS rebinding, cross-site reads)

- Every `/api` request except `/api/health` must carry `X-DataLab-Request: 1`. A browser cannot attach a custom
  header to a cross-site request without a CORS preflight, and the server never answers preflights, so
  `<form>`, `<img>`, `<script>` and `fetch(..., {mode: 'no-cors'})` from other sites are rejected (403).
- Requests with `Sec-Fetch-Site: cross-site`, or with an `Origin` that differs from the `Host`, are rejected (403).
- `Host` must be in the allow-list (421 otherwise). On a loopback bind the list is `127.0.0.1`, `localhost` and
  `::1`; a network bind adds the names in `APP_ALLOWED_HOSTS`. This defeats DNS rebinding, where an attacker's
  domain is re-pointed to `127.0.0.1`.
- Mutating requests must be `application/json` (415 otherwise) and at most 1 MiB (413). After a 413 or 415 the
  connection is closed so an unread body cannot be interpreted as the next request.

### Network exposure

- The server binds to `127.0.0.1` by default. It **refuses to start** on a non-loopback address without
  `APP_ACCESS_TOKEN`, and refuses a token shorter than 16 characters.
- The token is compared in constant time (`crypto.timingSafeEqual`), never echoed and never logged. The browser
  keeps it in `sessionStorage` (cleared when the tab closes), never in `localStorage`.
- There is no built-in TLS. On a network bind, put a TLS-terminating reverse proxy in front and list its public
  name in `APP_ALLOWED_HOSTS`.

### Credential handling

- Passwords are accepted once, kept in server memory, and never returned (the UI shows "set" / "not set"), logged,
  or written to disk by the app. `SHOW GRANTS` output is redacted (`IDENTIFIED BY PASSWORD '***'`).
- **A stored password is never sent to a different endpoint.** Changing the host, port, user or TLS mode on the
  Connections page requires re-entering the password (and the admin password, for the admin account). Without
  this, a page that could change the host could make the server send the configured password to a host it
  controls.
- The TLS mode cannot be weakened below the `.env` setting. `DB_OVERRIDE_HOST_ALLOWLIST` optionally limits which
  hosts may be chosen at all, and `ALLOW_CONNECTION_OVERRIDE` defaults to off on a network bind.
- The connector only accepts known authentication plugins (`restrictedAuth`), so a hostile server cannot request
  the cleartext-password plugin.

### SQL injection and arbitrary SQL

- The browser cannot submit SQL. Every statement is fixed server-side; values are bound parameters.
- Identifiers (tables, columns, sort keys, filter fields, object names, benchmark scenarios, presets) come from
  allow-lists and are looked up with `Object.hasOwn`, so names such as `__proto__` or `constructor` are rejected
  instead of resolving to built-in properties. Filter values are typed and validated; `LIKE` patterns are escaped.
- Object definitions come only from `sql/objects/` on disk. Views and routines use `SQL SECURITY INVOKER`.

### Destructive operations

- Schemas are created only after the operator types the schema name. The app **never drops a database or
  schema** and rejects system schemas.
- It never adopts an object it does not own: in a schema without the ownership marker, any existing table, view,
  routine, trigger or event with a name the Data Lab uses blocks installation. Unrelated tables may share the
  schema only after an explicit opt-in, and are never read, changed or dropped.
- Cleanup truncates only the lab's own tables, inside the configured schema, after typed confirmation, and is
  refused while a table outside the lab references a lab table by foreign key.
- Partitioning experiments work on a copy (`exp_orders_partitioned`); `orders` is never altered.
- Server-wide variables are read, never set. Diagnostics and the Server Assessment are read-only (`SELECT` and
  `SHOW` only; the assessment sets `max_statement_time` for its own session).

### Resource exhaustion

- Only one data job (generation, import, transform, cleanup, validation, objects, partition experiment, benchmark)
  runs at a time. Starting is serialized, so two simultaneous start requests cannot both pass the check.
- Long-running read endpoints have concurrency caps (429 beyond them): connection tests, live progress streams,
  uploads, file previews, row counts, browsing, charts, object examples, diagnostics.
- Heavy queries run with `max_statement_time`. Generation runs above `GEN_CONFIRM_ROWS_THRESHOLD` and benchmarks
  above `BENCH_HEAVY_*` (concurrency, duration, iterations, rows written) require typed confirmation; every
  benchmark has a wall-clock cap, including iteration mode.
- The CSV parser bounds field length and field count, also inside an unterminated quote or a file without line
  breaks. Uploads are limited by `IMPORT_MAX_UPLOAD_MB` and accept only the nine known Olist file names.

### Information disclosure

- Database errors are reduced to code, message and hint; SQL text and parameter values are removed. Unexpected
  errors return "Internal server error" and are logged server-side without credentials.
- Static files are served only from `public/`; paths are decoded, NUL bytes rejected, and the normalized path must
  stay inside the directory.
- Security headers on every response: CSP `default-src 'self'` with no inline script or style, `frame-ancestors
  'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, COOP and CORP `same-origin`, and a
  restrictive `Permissions-Policy`. The frontend builds the DOM with `textContent`, never `innerHTML` from data.

### Server Assessment exports

- Variables that can hold a credential (`report_password`, `wsrep_sst_auth`, key-management tokens, passwords in
  `wsrep_provider_options`, plugin `*_password` / `*_secret` settings) are replaced by `***` on the server, before
  the response is sent; `SHOW GRANTS` output is redacted as on the Connections page. An integration test checks
  that the configured passwords never appear in the assessment.
- Exports contain host names, addresses, ports and paths. The HTML report escapes every value from the server, and
  CSV cells that start with `=`, `+`, `-` or `@` are neutralized against formula injection.
- One assessment runs at a time (429 beyond that).

### Privacy

- No real personal data is generated. Names are random combinations, e-mail addresses use the reserved
  `example.com` / `example.net` domains, phone numbers use the non-existent area code `00`.
- The Olist dataset is not bundled. Importing requires acknowledging its licence (CC BY-NC-SA 4.0); see
  [datasets/README.md](../datasets/README.md).

## Review log (Phase 5)

An internal review of the whole codebase found the following, all fixed and covered by tests where testable:

| # | Finding | Fix |
|---|---|---|
| 1 | A changed connection host could receive the stored password | Re-entry required for any endpoint, user or TLS change; TLS cannot be weakened; optional host allow-list |
| 2 | Cross-site `GET` requests (e.g. an `<img>` tag on another site) could trigger expensive read endpoints on a token-less loopback server | Custom request header, `Sec-Fetch-Site` check |
| 3 | Network bind without a token was only a warning | Startup refusal; minimum token length |
| 4 | Two simultaneous job starts could both pass the "one job at a time" check | Start slot reserved synchronously |
| 5 | `__proto__` / `constructor` as preset, scenario or table name resolved to built-in properties | `Object.hasOwn` lookups everywhere |
| 6 | Iteration-mode benchmarks bypassed the heavy-run confirmation and had no time limit | Iteration and rows-written thresholds, wall-clock cap for every mode |
| 7 | An unterminated quote could make the CSV parser buffer a whole file into one field | Field length bounded during accumulation |
| 8 | No concurrency caps on expensive read endpoints | Per-endpoint limiters (429) |
| 9 | After a 413 the unread body could be parsed as the next request on a keep-alive connection | `Connection: close` and socket destroy after 413/415 |
| 10 | The connector accepted any authentication plugin the server requested | `restrictedAuth` list |

Accepted risk: when connection overrides are enabled (default on loopback only), the operator can point the app
at another schema name on the same server. The name-conflict guard, the shared-schema opt-in and the system-schema
  rejection still apply,
and the runtime account's grants are the final limit. Grant the accounts only on the lab schema
([PERMISSIONS.md](PERMISSIONS.md)).

## Operator checklist

1. Use a non-production MariaDB server and dedicated accounts with grants only on the lab schema.
2. Keep `APP_HOST=127.0.0.1`. If you must expose it: set a long random `APP_ACCESS_TOKEN`, set
   `APP_ALLOWED_HOSTS`, terminate TLS in a reverse proxy, and leave `ALLOW_CONNECTION_OVERRIDE=false`.
3. Use `DB_SSL=verify` with `DB_SSL_CA` when the database is not on the same host.
4. Keep `.env` out of version control (it is git-ignored) and readable only by the account running the app.
5. Run `npm audit` after dependency updates; the only runtime dependency is `mariadb`.
