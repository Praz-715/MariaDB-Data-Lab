// Definitions of the Brazilian E-Commerce Public Dataset by Olist: expected
// files, headers, staging tables and per-column validation. Validation turns raw
// CSV text into typed staging values or a rejection reason.
import { STATES } from '../generators/reference-data.js';

export const OLIST_SOURCE = {
  id: 'olist',
  name: 'Brazilian E-Commerce Public Dataset by Olist',
  url: 'https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce',
  licence: 'CC BY-NC-SA 4.0 (as listed on Kaggle; verify before use)',
  licenceNote: 'Non-commercial use with attribution and share-alike. Download it yourself; it is not bundled or redistributed.',
};

const HEX32 = /^[0-9a-f]{32}$/;
const TS = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

const t = {
  hex32: { kind: 'hex32' },
  zip: { kind: 'zip' },
  uf: { kind: 'uf' },
  str: (max) => ({ kind: 'string', max }),
  text: (max) => ({ kind: 'text', max }),
  int: (min, max) => ({ kind: 'int', min, max }),
  money: (min, max) => ({ kind: 'money', min, max }),
  float: (min, max) => ({ kind: 'float', min, max }),
  ts: { kind: 'timestamp' },
  enumOf: (...values) => ({ kind: 'enum', values }),
};

// col(src header, staging column, type, required)
const col = (src, dst, type, required = true) => ({ src, dst, type, required });

export const OLIST_FILES = [
  {
    key: 'category_translation', file: 'product_category_name_translation.csv', table: 'stg_olist_category_translation', required: false,
    target: 'product_categories (leaf names)',
    columns: [col('product_category_name', 'category_name', t.str(80)), col('product_category_name_english', 'category_name_english', t.str(80))],
  },
  {
    key: 'geolocation', file: 'olist_geolocation_dataset.csv', table: 'stg_olist_geolocation', required: false,
    target: 'geographic_locations (one row per zip prefix: mean coordinates, most frequent city)',
    columns: [
      col('geolocation_zip_code_prefix', 'zip_prefix', t.zip), col('geolocation_lat', 'lat', t.float(-90, 90)), col('geolocation_lng', 'lng', t.float(-180, 180)),
      col('geolocation_city', 'city', t.str(80)), col('geolocation_state', 'state', t.uf),
    ],
  },
  {
    key: 'customers', file: 'olist_customers_dataset.csv', table: 'stg_olist_customers', required: true,
    target: 'customers (one per customer_unique_id), customer_addresses (one per distinct zip)',
    columns: [
      col('customer_id', 'customer_id', t.hex32), col('customer_unique_id', 'customer_unique_id', t.hex32), col('customer_zip_code_prefix', 'zip_prefix', t.zip),
      col('customer_city', 'city', t.str(80)), col('customer_state', 'state', t.uf),
    ],
  },
  {
    key: 'sellers', file: 'olist_sellers_dataset.csv', table: 'stg_olist_sellers', required: true,
    target: 'sellers, seller_addresses',
    columns: [col('seller_id', 'seller_id', t.hex32), col('seller_zip_code_prefix', 'zip_prefix', t.zip), col('seller_city', 'city', t.str(80)), col('seller_state', 'state', t.uf)],
  },
  {
    key: 'products', file: 'olist_products_dataset.csv', table: 'stg_olist_products', required: true,
    target: 'products (one per product × seller listing), product_attributes, inventory',
    columns: [
      col('product_id', 'product_id', t.hex32), col('product_category_name', 'category_name', t.str(80), false),
      col('product_name_lenght', 'name_length', t.int(0, 10000), false), col('product_description_lenght', 'description_length', t.int(0, 100000), false),
      col('product_photos_qty', 'photos_qty', t.int(0, 1000), false), col('product_weight_g', 'weight_g', t.int(0, 1000000), false),
      col('product_length_cm', 'length_cm', t.int(0, 10000), false), col('product_height_cm', 'height_cm', t.int(0, 10000), false),
      col('product_width_cm', 'width_cm', t.int(0, 10000), false),
    ],
  },
  {
    key: 'orders', file: 'olist_orders_dataset.csv', table: 'stg_olist_orders', required: true,
    target: 'orders, shipments, shipment_tracking_events',
    columns: [
      col('order_id', 'order_id', t.hex32), col('customer_id', 'customer_id', t.hex32),
      col('order_status', 'status', t.enumOf('delivered', 'shipped', 'canceled', 'unavailable', 'invoiced', 'processing', 'created', 'approved')),
      col('order_purchase_timestamp', 'purchased_at', t.ts), col('order_approved_at', 'approved_at', t.ts, false),
      col('order_delivered_carrier_date', 'carrier_at', t.ts, false), col('order_delivered_customer_date', 'delivered_at', t.ts, false),
      col('order_estimated_delivery_date', 'estimated_at', t.ts, false),
    ],
  },
  {
    key: 'order_items', file: 'olist_order_items_dataset.csv', table: 'stg_olist_order_items', required: true,
    target: 'order_items (quantity 1 per Olist line), inventory_movements (sales)',
    columns: [
      col('order_id', 'order_id', t.hex32), col('order_item_id', 'item_seq', t.int(1, 1000)), col('product_id', 'product_id', t.hex32),
      col('seller_id', 'seller_id', t.hex32), col('shipping_limit_date', 'shipping_limit_at', t.ts, false),
      col('price', 'price', t.money(0.01, 1_000_000)), col('freight_value', 'freight', t.money(0, 100_000)),
    ],
  },
  {
    key: 'payments', file: 'olist_order_payments_dataset.csv', table: 'stg_olist_payments', required: true,
    target: 'payments, payment_transactions (reconciled to the order total)',
    columns: [
      col('order_id', 'order_id', t.hex32), col('payment_sequential', 'payment_seq', t.int(1, 1000)),
      col('payment_type', 'payment_type', t.enumOf('credit_card', 'boleto', 'voucher', 'debit_card', 'not_defined')),
      col('payment_installments', 'installments', t.int(0, 100)), col('payment_value', 'amount', t.money(0, 1_000_000)),
    ],
  },
  {
    key: 'reviews', file: 'olist_order_reviews_dataset.csv', table: 'stg_olist_reviews', required: false,
    target: 'product_reviews (latest review per delivered order, on its first line)',
    columns: [
      col('review_id', 'review_id', t.hex32), col('order_id', 'order_id', t.hex32), col('review_score', 'score', t.int(1, 5)),
      col('review_comment_title', 'title', t.text(255), false), col('review_comment_message', 'message', t.text(5000), false),
      col('review_creation_date', 'created_at', t.ts, false), col('review_answer_timestamp', 'answered_at', t.ts, false),
    ],
  },
];

export const FILE_BY_KEY = new Map(OLIST_FILES.map((f) => [f.key, f]));
export const FILE_BY_NAME = new Map(OLIST_FILES.map((f) => [f.file, f]));
export const STAGING_TABLES = OLIST_FILES.map((f) => f.table);

function parseTimestamp(s) {
  const m = TS.exec(s);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', se = '00'] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== iso.slice(0, 19)) return null;
  if (+y < 2000 || +y > 2100) return null;
  return `${y}-${mo}-${d} ${h}:${mi}:${se}`;
}

// Returns [value, error]. Empty optional values become null.
export function validateValue(type, raw, required) {
  const s = raw == null ? '' : String(raw).trim();
  if (s === '') return required ? [null, 'required value missing'] : [null, null];
  switch (type.kind) {
    case 'hex32':
      return HEX32.test(s) ? [s, null] : [null, 'not a 32-character hex id'];
    case 'zip':
      return /^\d{3,5}$/.test(s) ? [s.padStart(5, '0'), null] : [null, 'zip prefix must have 3-5 digits'];
    case 'uf': {
      const u = s.toUpperCase();
      return STATES[u] ? [u, null] : [null, 'unknown Brazilian state code'];
    }
    case 'string':
      return s.length <= type.max ? [s, null] : [null, `longer than ${type.max} characters`];
    case 'text':
      return [s.length <= type.max ? s : s.slice(0, type.max), null];
    case 'int': {
      if (!/^-?\d+(\.0+)?$/.test(s)) return [null, 'not an integer'];
      const n = parseInt(s, 10);
      return n >= type.min && n <= type.max ? [n, null] : [null, `integer outside ${type.min}..${type.max}`];
    }
    case 'money': {
      if (!/^\d+(\.\d{1,2})?$/.test(s)) return [null, 'not a non-negative amount with up to 2 decimals'];
      const n = Number(s);
      return n >= type.min && n <= type.max ? [n.toFixed(2), null] : [null, `amount outside ${type.min}..${type.max}`];
    }
    case 'float': {
      const n = Number(s);
      if (!Number.isFinite(n) || !/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s)) return [null, 'not a number'];
      return n >= type.min && n <= type.max ? [n, null] : [null, `number outside ${type.min}..${type.max}`];
    }
    case 'timestamp': {
      const v = parseTimestamp(s);
      return v ? [v, null] : [null, 'not a valid timestamp (YYYY-MM-DD HH:MM:SS)'];
    }
    case 'enum':
      return type.values.includes(s) ? [s, null] : [null, `unexpected value (allowed: ${type.values.join(', ')})`];
    default:
      return [null, 'unknown type'];
  }
}

const norm = (h) => h.trim().toLowerCase();

// Maps header names to positions. Column order may differ from the reference;
// missing required columns block the import, extra columns are ignored.
export function checkHeader(def, header) {
  const index = new Map(header.map((h, i) => [norm(h), i]));
  const positions = def.columns.map((c) => index.get(c.src) ?? -1);
  const missing = def.columns.filter((c, i) => positions[i] === -1).map((c) => c.src);
  const known = new Set(def.columns.map((c) => c.src));
  const extra = header.map(norm).filter((h) => h && !known.has(h));
  return { ok: missing.length === 0, missing, extra, positions };
}

// Validates one data record. Returns { values } in staging column order (without
// src_row) or { error, column }.
export function validateRecord(def, positions, fields) {
  const values = [];
  for (let i = 0; i < def.columns.length; i++) {
    const c = def.columns[i];
    const [v, err] = validateValue(c.type, fields[positions[i]], c.required);
    if (err) return { error: `${c.src}: ${err}`, column: c.src };
    values.push(v);
  }
  return { values };
}

export function stagingColumns(def) {
  return ['src_row', ...def.columns.map((c) => c.dst)];
}
