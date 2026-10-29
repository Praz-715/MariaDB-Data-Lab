// CSV -> staging import. Each file is one phase; each unit is a fixed range of
// data records, validated and inserted in one transaction together with its
// ledger row, so a resumed import continues exactly after the last committed
// unit. Files are streamed; only one unit of records is held in memory.
import fs from 'node:fs';
import { HttpError } from '../http.js';
import { query } from '../db.js';
import { parseCsv } from './csv.js';
import { checkHeader, validateRecord, stagingColumns } from './olist.js';
import { filePath } from './datasetFiles.js';

const REJECT_SAMPLES_PER_UNIT = 50;

const sqlCache = new Map();
export function insertSqlFor(table, columns) {
  const key = `${table}|${columns.join(',')}`;
  let sql = sqlCache.get(key);
  if (!sql) {
    sql = `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    sqlCache.set(key, sql);
  }
  return sql;
}

export async function insertBatched(conn, table, columns, rows, batchSize) {
  for (let i = 0; i < rows.length; i += batchSize) await conn.batch(insertSqlFor(table, columns), rows.slice(i, i + batchSize));
}

// Sequential reader that hands out fixed-size units of data records. Units are
// requested in increasing order; an earlier unit (a retry) is served from cache
// or by reopening the file.
class UnitReader {
  constructor(def, unitSize) {
    this.def = def;
    this.unitSize = unitSize;
    this.cache = null;
    this.open();
  }

  open() {
    this.stream?.destroy();
    this.stream = fs.createReadStream(filePath(this.def), { highWaterMark: 1 << 20 });
    this.iter = parseCsv(this.stream)[Symbol.asyncIterator]();
    this.next = 1;
    this.positions = null;
  }

  async header() {
    const { value, done } = await this.iter.next();
    if (done) throw new HttpError(400, `${this.def.file} is empty`);
    const check = checkHeader(this.def, value.fields);
    if (!check.ok) throw new HttpError(400, `${this.def.file}: missing columns ${check.missing.join(', ')}`);
    this.positions = check.positions;
  }

  async unit(k) {
    if (this.cache?.k === k) return this.cache.records;
    const start = k * this.unitSize + 1;
    if (start < this.next) this.open();
    if (!this.positions) await this.header();
    while (this.next < start) {
      const { done } = await this.iter.next();
      if (done) return [];
      this.next++;
    }
    const records = [];
    while (records.length < this.unitSize) {
      const { value, done } = await this.iter.next();
      if (done) break;
      records.push({ row: this.next++, fields: value.fields, error: value.error });
    }
    this.cache = { k, records };
    return records;
  }

  close() {
    this.stream?.destroy();
  }
}

// files: [{ def, records }] where records comes from the pre-import scan.
export function buildStagingPhases({ jobId, files, cfg }) {
  const readers = [];
  const phases = files.map(({ def, records }) => {
    const columns = stagingColumns(def);
    let reader = null;
    return {
      key: `stage:${def.key}`,
      label: `Stage ${def.file}`,
      units: Math.ceil(records / cfg.commitInterval),
      concurrency: 1,
      run: async (conn, unit) => {
        if (!reader) {
          reader = new UnitReader(def, cfg.commitInterval);
          readers.push(reader);
        }
        const recs = await reader.unit(unit);
        const rows = [];
        const rejects = [];
        const counts = { _records: recs.length };
        for (const r of recs) {
          const v = r.error ? { error: `malformed CSV: ${r.error}` } : validateRecord(def, reader.positions, r.fields);
          if (v.error) {
            const reason = v.error.slice(0, 200);
            const key = `_rej|${def.key}|${reason.replace(/\d{3,}/g, 'N')}`;
            counts[key] = (counts[key] || 0) + 1;
            if (rejects.length < REJECT_SAMPLES_PER_UNIT) rejects.push([jobId, def.key, r.row, reason, r.fields.join(',').slice(0, 500)]);
          } else {
            rows.push([r.row, ...v.values]);
          }
        }
        await insertBatched(conn, def.table, columns, rows, cfg.batchSize);
        await insertBatched(conn, 'stg_import_rejects', ['job_id', 'file_key', 'src_row', 'reason', 'raw_excerpt'], rejects, cfg.batchSize);
        counts[def.table] = rows.length;
        counts._rejected = recs.length - rows.length;
        return counts;
      },
    };
  });
  phases.close = () => readers.forEach((r) => r.close());
  return phases;
}

// Cross-file integrity of what is currently staged. Each check counts records
// the transform will skip or repair.
const CHECKS = [
  ['orders_without_customer', 'warn', 'Orders whose customer_id is not in the customers file', 'Skipped by the transform',
    'SELECT COUNT(*) AS n FROM stg_olist_orders o WHERE NOT EXISTS (SELECT 1 FROM stg_olist_customers c WHERE c.customer_id = o.customer_id)'],
  ['orders_without_items', 'warn', 'Orders without any order item', 'Skipped: every lab order needs at least one item',
    'SELECT COUNT(*) AS n FROM stg_olist_orders o WHERE NOT EXISTS (SELECT 1 FROM stg_olist_order_items i WHERE i.order_id = o.order_id)'],
  ['orders_without_payments', 'info', 'Orders without any payment', 'A payment equal to the order total is synthesized',
    'SELECT COUNT(*) AS n FROM stg_olist_orders o WHERE NOT EXISTS (SELECT 1 FROM stg_olist_payments p WHERE p.order_id = o.order_id)'],
  ['items_without_order', 'warn', 'Order items whose order is not in the orders file', 'Ignored',
    'SELECT COUNT(*) AS n FROM stg_olist_order_items i WHERE NOT EXISTS (SELECT 1 FROM stg_olist_orders o WHERE o.order_id = i.order_id)'],
  ['items_unknown_product', 'warn', 'Order items whose product is not in the products file', 'Item dropped; payments are reconciled to the remaining total',
    'SELECT COUNT(*) AS n FROM stg_olist_order_items i WHERE NOT EXISTS (SELECT 1 FROM stg_olist_products p WHERE p.product_id = i.product_id)'],
  ['items_unknown_seller', 'warn', 'Order items whose seller is not in the sellers file', 'Item dropped',
    'SELECT COUNT(*) AS n FROM stg_olist_order_items i WHERE NOT EXISTS (SELECT 1 FROM stg_olist_sellers s WHERE s.seller_id = i.seller_id)'],
  ['payments_without_order', 'info', 'Payments whose order is not in the orders file', 'Ignored',
    'SELECT COUNT(*) AS n FROM stg_olist_payments p WHERE NOT EXISTS (SELECT 1 FROM stg_olist_orders o WHERE o.order_id = p.order_id)'],
  ['reviews_without_order', 'info', 'Reviews whose order is not in the orders file', 'Ignored',
    'SELECT COUNT(*) AS n FROM stg_olist_reviews r WHERE NOT EXISTS (SELECT 1 FROM stg_olist_orders o WHERE o.order_id = r.order_id)'],
  ['multi_review_orders', 'info', 'Orders with more than one review', 'Only the latest review is kept',
    'SELECT COUNT(*) AS n FROM (SELECT order_id FROM stg_olist_reviews GROUP BY order_id HAVING COUNT(*) > 1) x'],
  ['duplicate_order_ids', 'warn', 'Duplicate order_id rows in the orders file', 'The first occurrence is used',
    'SELECT COALESCE(SUM(c - 1), 0) AS n FROM (SELECT COUNT(*) AS c FROM stg_olist_orders GROUP BY order_id HAVING c > 1) x'],
  ['duplicate_product_ids', 'warn', 'Duplicate product_id rows in the products file', 'The first occurrence is used',
    'SELECT COALESCE(SUM(c - 1), 0) AS n FROM (SELECT COUNT(*) AS c FROM stg_olist_products GROUP BY product_id HAVING c > 1) x'],
  ['multi_seller_products', 'info', 'Products sold by more than one seller', 'Each product × seller pair becomes its own listing',
    'SELECT COUNT(*) AS n FROM (SELECT product_id FROM stg_olist_order_items GROUP BY product_id HAVING COUNT(DISTINCT seller_id) > 1) x'],
  ['products_without_category', 'info', 'Products without a category', "Assigned to the 'uncategorized' leaf",
    'SELECT COUNT(*) AS n FROM stg_olist_products WHERE category_name IS NULL'],
  ['untranslated_categories', 'info', 'Categories without an English translation', 'The Portuguese name is used',
    'SELECT COUNT(DISTINCT p.category_name) AS n FROM stg_olist_products p WHERE p.category_name IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stg_olist_category_translation t WHERE t.category_name = p.category_name)'],
  ['zips_without_geolocation', 'info', 'Customer and seller zip prefixes missing from the geolocation file', 'Placed at the state centroid',
    'SELECT COUNT(*) AS n FROM (SELECT zip_prefix FROM stg_olist_customers UNION SELECT zip_prefix FROM stg_olist_sellers) z WHERE NOT EXISTS (SELECT 1 FROM stg_olist_geolocation g WHERE g.zip_prefix = z.zip_prefix)'],
  ['delivered_without_date', 'info', "Orders 'delivered' without a delivery date", "Imported as 'shipped'",
    "SELECT COUNT(*) AS n FROM stg_olist_orders WHERE status = 'delivered' AND delivered_at IS NULL"],
  ['delivery_before_shipping', 'info', 'Orders delivered before the carrier pickup date', 'Delivery moved to the pickup time',
    'SELECT COUNT(*) AS n FROM stg_olist_orders WHERE delivered_at < carrier_at'],
  ['reviews_before_delivery', 'info', 'Reviews created before the order was delivered', 'Review time moved to one hour after delivery',
    'SELECT COUNT(*) AS n FROM stg_olist_reviews r JOIN stg_olist_orders o ON o.order_id = r.order_id WHERE r.created_at < o.delivered_at'],
];

export async function stagingReport() {
  const tables = {};
  for (const t of ['stg_olist_category_translation', 'stg_olist_geolocation', 'stg_olist_customers', 'stg_olist_sellers', 'stg_olist_products', 'stg_olist_orders', 'stg_olist_order_items', 'stg_olist_payments', 'stg_olist_reviews']) {
    tables[t] = Number((await query(`SELECT COUNT(*) AS n FROM \`${t}\``))[0].n);
  }
  const checks = [];
  if (tables.stg_olist_orders > 0) {
    for (const [id, severity, title, consequence, sql] of CHECKS) {
      const [r] = await query(`SET STATEMENT max_statement_time = 120 FOR ${sql}`);
      checks.push({ id, severity, title, consequence, count: Number(r.n) });
    }
  }
  const required = ['stg_olist_customers', 'stg_olist_sellers', 'stg_olist_products', 'stg_olist_orders', 'stg_olist_order_items', 'stg_olist_payments'];
  return { tables, checks, readyForTransform: required.every((t) => tables[t] > 0), missingRequired: required.filter((t) => tables[t] === 0) };
}
