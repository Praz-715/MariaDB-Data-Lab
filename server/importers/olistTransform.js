// Transform: staged Olist rows -> lab tables. Olist provides orders, items,
// payments, reviews, customers, sellers, products and geography; attributes the
// lab schema needs but Olist lacks (names, contact details, shipments, tracking,
// inventory) are synthesized deterministically from the target id. Business-rule
// conflicts in the source (e.g. delivery before pickup, payments that do not add
// up) are repaired and every repair is counted in the job statistics as
// "_fix|<kind>", so the report shows exactly what changed.
import { query } from '../db.js';
import { Rng, cumulative } from '../generators/prng.js';
import * as REF from '../generators/reference-data.js';
import { runStockUnit, runSummaryUnit, monthStarts } from '../jobs/generationEngine.js';
import { insertBatched } from './stagingImport.js';

const DAY = 86400;
const HOUR = 3600;
const STREAM = { CUSTOMER: 101, SELLER: 102, PRODUCT: 103, ORDER: 104 };

const COLS = {
  currencies: ['currency_code', 'currency_name', 'symbol', 'decimal_places', 'rate_to_brl'],
  customer_segments: ['segment_id', 'segment_code', 'segment_name', 'description'],
  shipping_carriers: ['carrier_id', 'carrier_code', 'carrier_name', 'service_level', 'base_rate', 'per_kg_rate', 'avg_transit_days', 'is_active'],
  geographic_locations: ['location_id', 'zip_prefix', 'city', 'state_code', 'state_name', 'region', 'latitude', 'longitude'],
  warehouses: ['warehouse_id', 'warehouse_code', 'warehouse_name', 'location_id', 'capacity_units', 'opened_at'],
  product_categories: ['category_id', 'parent_category_id', 'category_code', 'category_name', 'depth'],
  map_olist_ids: ['entity', 'source_key', 'target_id'],
  customers: ['customer_id', 'customer_code', 'first_name', 'last_name', 'email', 'phone', 'birth_date', 'segment_id', 'status', 'marketing_opt_in', 'created_at'],
  customer_addresses: ['customer_id', 'address_seq', 'address_type', 'street', 'street_number', 'complement', 'district', 'zip_code', 'location_id', 'is_default', 'created_at'],
  sellers: ['seller_id', 'seller_code', 'legal_name', 'display_name', 'email', 'phone', 'rating', 'status', 'home_warehouse_id', 'created_at'],
  seller_addresses: ['seller_id', 'address_seq', 'address_type', 'street', 'street_number', 'district', 'zip_code', 'location_id'],
  products: ['product_id', 'sku', 'seller_id', 'category_id', 'product_name', 'list_price', 'cost_price', 'weight_g', 'length_cm', 'height_cm', 'width_cm', 'status', 'created_at'],
  product_attributes: ['product_id', 'attribute_name', 'attribute_value'],
  inventory: ['product_id', 'warehouse_id', 'quantity_on_hand', 'reorder_level', 'updated_at'],
  inventory_movements: ['product_id', 'warehouse_id', 'movement_type', 'quantity', 'order_id', 'moved_at', 'note'],
  orders: ['order_id', 'order_code', 'customer_id', 'shipping_address_seq', 'status', 'currency_code', 'items_subtotal', 'shipping_total', 'discount_total', 'total_amount', 'purchased_at', 'approved_at', 'estimated_delivery_at', 'delivered_at', 'canceled_at'],
  shipments: ['order_id', 'shipment_seq', 'seller_id', 'warehouse_id', 'carrier_id', 'tracking_number', 'status', 'shipping_cost', 'weight_g', 'destination_location_id', 'created_at', 'shipped_at', 'estimated_delivery_at', 'delivered_at'],
  order_items: ['order_id', 'item_seq', 'product_id', 'shipment_seq', 'quantity', 'unit_price', 'freight_amount'],
  shipment_tracking_events: ['order_id', 'shipment_seq', 'event_seq', 'event_type', 'event_at', 'location_id', 'description'],
  payments: ['order_id', 'payment_seq', 'payment_method', 'installments', 'amount', 'status', 'created_at', 'captured_at'],
  payment_transactions: ['order_id', 'payment_seq', 'txn_seq', 'txn_type', 'txn_status', 'amount', 'processor_ref', 'created_at'],
  product_reviews: ['order_id', 'item_seq', 'rating', 'title', 'comment', 'created_at', 'answered_at'],
};
const ORDER_TABLES = ['orders', 'shipments', 'order_items', 'shipment_tracking_events', 'payments', 'payment_transactions', 'product_reviews', 'inventory_movements'];

// ---------------------------------------------------------------- helpers

const toTs = (s) => (s == null ? null : Math.floor(Date.parse(`${String(s).replace(' ', 'T')}Z`) / 1000));
const fmt = (ts) => (ts == null ? null : new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' '));
const cents = (d) => Math.round(Number(d) * 100);
const money = (c) => `${Math.trunc(c / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
const base36 = (n, w) => n.toString(36).toUpperCase().padStart(w, '0');
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const titleCase = (s) => s.replace(/_/g, ' ').toLowerCase().replace(/(^|[\s/-])\p{L}/gu, (c) => c.toUpperCase());
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function bump(counts, key, n = 1) {
  counts[key] = (counts[key] || 0) + n;
}

async function insertAll(conn, out, tables, counts, batchSize) {
  for (const t of tables) {
    const rows = out[t];
    if (!rows?.length) continue;
    await insertBatched(conn, t, COLS[t], rows, batchSize);
    bump(counts, t, rows.length);
  }
}

const sink = (tables) => Object.fromEntries(tables.map((t) => [t, []]));

function personName(r) {
  const first = r.pick(REF.FIRST_NAMES);
  const last = r.chance(0.4) ? `${r.pick(REF.LAST_NAMES)} ${r.pick(REF.LAST_NAMES)}` : r.pick(REF.LAST_NAMES);
  return [first, last];
}

function streetAddress(r, zip) {
  return {
    street: `${r.pick(REF.STREET_TYPES)} ${r.pick(REF.STREET_NAMES)}`,
    number: String(r.int(1, 4999)),
    district: r.pick(REF.DISTRICTS),
    zip: `${zip}-${String(r.int(0, 999)).padStart(3, '0')}`,
  };
}

// ---------------------------------------------------------------- lookups shared by phases

function createLookups() {
  let locations = null;
  let warehouses = null;
  let categories = null;
  return {
    async locations() {
      if (!locations) {
        const rows = await query('SELECT location_id, zip_prefix, city, state_code, region, latitude, longitude FROM geographic_locations');
        locations = new Map(rows.map((l) => [l.zip_prefix, { id: l.location_id, city: l.city, state: l.state_code, region: l.region, lat: Number(l.latitude), lng: Number(l.longitude) }]));
      }
      return locations;
    },
    async warehouses() {
      if (!warehouses) {
        warehouses = (await query('SELECT w.warehouse_id, w.location_id, g.latitude, g.longitude FROM warehouses w JOIN geographic_locations g ON g.location_id = w.location_id')).map((w) => ({
          id: w.warehouse_id, locationId: w.location_id, lat: Number(w.latitude), lng: Number(w.longitude),
        }));
      }
      return warehouses;
    },
    async categories() {
      if (!categories) categories = new Map((await query("SELECT source_key, target_id FROM map_olist_ids WHERE entity = 'category'")).map((r) => [r.source_key, r.target_id]));
      return categories;
    },
  };
}

function nearest(list, lat, lng) {
  let best = list[0];
  let bestD = Infinity;
  for (const w of list) {
    const dx = (w.lng - lng) * Math.cos((lat * Math.PI) / 180);
    const dy = w.lat - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  }
  return best;
}

async function countEntity(entity) {
  return Number((await query('SELECT COUNT(*) AS n FROM map_olist_ids WHERE entity = ?', [entity]))[0].n);
}

// ---------------------------------------------------------------- phase: id maps

async function runMapUnit(conn) {
  const counts = {};
  const ins = async (entity, select) => {
    const r = await conn.query(`INSERT INTO map_olist_ids (entity, source_key, target_id) ${select}`, [entity]);
    bump(counts, 'map_olist_ids', r.affectedRows);
  };
  await ins('customer', 'SELECT ?, u, ROW_NUMBER() OVER (ORDER BY u) FROM (SELECT DISTINCT customer_unique_id AS u FROM stg_olist_customers) x');
  await ins('seller', 'SELECT ?, s, ROW_NUMBER() OVER (ORDER BY s) FROM (SELECT DISTINCT seller_id AS s FROM stg_olist_sellers) x');
  await ins(
    'listing',
    `SELECT ?, CONCAT(product_id, seller_id), ROW_NUMBER() OVER (ORDER BY product_id, seller_id)
       FROM (SELECT DISTINCT i.product_id, i.seller_id FROM stg_olist_order_items i
              WHERE EXISTS (SELECT 1 FROM stg_olist_products p WHERE p.product_id = i.product_id)
                AND EXISTS (SELECT 1 FROM stg_olist_sellers s WHERE s.seller_id = i.seller_id)) x`,
  );
  // Orders are numbered in purchase order, and need a known customer and at least one importable item.
  await ins(
    'order',
    `SELECT ?, order_id, ROW_NUMBER() OVER (ORDER BY p, order_id)
       FROM (SELECT o.order_id, MIN(o.purchased_at) AS p FROM stg_olist_orders o
              WHERE EXISTS (SELECT 1 FROM stg_olist_customers c WHERE c.customer_id = o.customer_id)
                AND EXISTS (SELECT 1 FROM stg_olist_order_items i JOIN map_olist_ids m
                                ON m.entity = 'listing' AND m.source_key = CONCAT(i.product_id, i.seller_id)
                             WHERE i.order_id = o.order_id)
              GROUP BY o.order_id) x`,
  );
  const [skip] = await conn.query(
    `SELECT (SELECT COUNT(DISTINCT order_id) FROM stg_olist_orders) - (SELECT COUNT(*) FROM map_olist_ids WHERE entity = 'order') AS skipped_orders`,
  );
  bump(counts, '_skip|orders_without_customer_or_items', Number(skip.skipped_orders));
  return counts;
}

// ---------------------------------------------------------------- phase: reference data

async function runReferenceUnit(conn, cfg) {
  const counts = {};
  const out = sink(['currencies', 'customer_segments', 'shipping_carriers', 'geographic_locations', 'warehouses', 'product_categories', 'map_olist_ids']);
  out.currencies = REF.CURRENCIES.map(([c, n, s, d, rate]) => [c, n, s, d, rate.toFixed(8)]);
  out.customer_segments = REF.SEGMENTS.map((s) => [...s]);
  out.shipping_carriers = REF.CARRIERS.map(([id, code, name, level, base, perKg, median]) => [id, code, name, level, base.toFixed(2), perKg.toFixed(2), median.toFixed(2), 1]);

  // Geography: one location per zip prefix. City/state = most frequent pair in
  // the geolocation file; coordinates = mean of points inside Brazil's bounding
  // box. Prefixes used by customers or sellers but absent from geolocation are
  // placed at their state's centroid.
  const zips = new Map();
  for (const r of await conn.query('SELECT zip_prefix, city, state, COUNT(*) AS n FROM stg_olist_geolocation GROUP BY zip_prefix, city, state')) {
    const z = zips.get(r.zip_prefix);
    if (!z || Number(r.n) > z.n) zips.set(r.zip_prefix, { city: r.city, state: r.state, n: Number(r.n), lat: null, lng: null });
  }
  for (const r of await conn.query('SELECT zip_prefix, AVG(lat) AS lat, AVG(lng) AS lng FROM stg_olist_geolocation WHERE lat BETWEEN -34 AND 6 AND lng BETWEEN -74 AND -34 GROUP BY zip_prefix')) {
    const z = zips.get(r.zip_prefix);
    if (z) Object.assign(z, { lat: Number(r.lat), lng: Number(r.lng) });
  }
  const stateCentroid = new Map();
  for (const r of await conn.query('SELECT state, AVG(lat) AS lat, AVG(lng) AS lng FROM stg_olist_geolocation WHERE lat BETWEEN -34 AND 6 AND lng BETWEEN -74 AND -34 GROUP BY state')) {
    stateCentroid.set(r.state, { lat: Number(r.lat), lng: Number(r.lng) });
  }
  for (const [state, , lat, lng] of REF.CITIES) if (!stateCentroid.has(state)) stateCentroid.set(state, { lat, lng });
  for (const r of await conn.query('SELECT zip_prefix, MIN(city) AS city, MIN(state) AS state FROM (SELECT zip_prefix, city, state FROM stg_olist_customers UNION ALL SELECT zip_prefix, city, state FROM stg_olist_sellers) u GROUP BY zip_prefix')) {
    if (!zips.has(r.zip_prefix)) {
      zips.set(r.zip_prefix, { city: r.city, state: r.state, lat: null, lng: null });
      bump(counts, '_fix|zip_without_geolocation');
    }
  }
  let locationId = 0;
  const locs = [];
  for (const zip of [...zips.keys()].sort()) {
    const z = zips.get(zip);
    if (z.lat === null) Object.assign(z, stateCentroid.get(z.state) || { lat: -15.79, lng: -47.88 });
    const [stateName, region] = REF.STATES[z.state];
    const loc = { id: ++locationId, zip, city: titleCase(z.city).slice(0, 80), state: z.state, lat: z.lat, lng: z.lng };
    locs.push(loc);
    out.geographic_locations.push([loc.id, zip, loc.city, z.state, stateName, region, z.lat.toFixed(6), z.lng.toFixed(6)]);
  }

  // Fulfilment centres from the reference list, placed at a matching city when present.
  for (const [id, code, name, city, state, capacity, opened] of REF.WAREHOUSES) {
    const inState = locs.filter((l) => l.state === state);
    if (!inState.length) continue;
    const loc = inState.find((l) => slug(l.city) === slug(city)) || inState[0];
    out.warehouses.push([id, code, name, loc.id, capacity, opened]);
  }
  if (!out.warehouses.length && locs.length) {
    out.warehouses.push([1, 'WH-DEFAULT', `Fulfillment Center ${locs[0].city}`, locs[0].id, 500000, '2016-01-01']);
    bump(counts, '_fix|default_warehouse_created');
  }

  // Categories: reference top-level groups plus "other"; one leaf per Olist category.
  const parents = [...REF.CATEGORY_PARENTS, ['other', 'Other']];
  parents.forEach(([code, name], i) => out.product_categories.push([i + 1, null, code, name, 0]));
  const parentByLeaf = new Map(REF.CATEGORY_LEAVES.map((l) => [l[0], l[2]]));
  const parentId = new Map(parents.map(([code], i) => [code, i + 1]));
  const leaves = await conn.query(
    `SELECT p.category_name AS pt, (SELECT MIN(t.category_name_english) FROM stg_olist_category_translation t WHERE t.category_name = p.category_name) AS en
       FROM (SELECT DISTINCT category_name FROM stg_olist_products) p ORDER BY p.category_name`,
  );
  const usedCodes = new Set(parents.map(([c]) => c));
  let categoryId = parents.length;
  for (const l of leaves) {
    let code = slug(l.en || l.pt || 'uncategorized') || 'uncategorized';
    if (!l.en && l.pt) bump(counts, '_fix|category_untranslated');
    while (usedCodes.has(code)) code = `${code}_2`;
    usedCodes.add(code);
    const parent = parentId.get(parentByLeaf.get(code)) ?? parentId.get('other');
    out.product_categories.push([++categoryId, parent, code, titleCase(code).slice(0, 100), 1]);
    out.map_olist_ids.push(['category', l.pt ?? '', categoryId]);
  }

  await insertAll(conn, out, ['currencies', 'customer_segments', 'shipping_carriers', 'geographic_locations', 'warehouses', 'product_categories', 'map_olist_ids'], counts, cfg.batchSize);
  return counts;
}

// ---------------------------------------------------------------- phase: customers

async function runCustomerUnit(conn, cfg, tctx, lookups, unit) {
  const lo = unit * cfg.commitInterval + 1;
  const hi = (unit + 1) * cfg.commitInterval;
  const rows = await conn.query(
    `SELECT m.target_id AS id, c.zip_prefix, MIN(o.purchased_at) AS first_purchase, COUNT(DISTINCT o.order_id) AS orders
       FROM map_olist_ids m
       JOIN stg_olist_customers c ON c.customer_unique_id = m.source_key
       LEFT JOIN stg_olist_orders o ON o.customer_id = c.customer_id
      WHERE m.entity = 'customer' AND m.target_id BETWEEN ? AND ?
      GROUP BY m.target_id, c.zip_prefix
      ORDER BY m.target_id, c.zip_prefix`,
    [lo, hi],
  );
  const locations = await lookups.locations();
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.id)) byId.set(r.id, { zips: [], first: null, orders: 0 });
    const c = byId.get(r.id);
    c.zips.push(r.zip_prefix);
    const t = toTs(r.first_purchase);
    if (t !== null && (c.first === null || t < c.first)) c.first = t;
    c.orders += Number(r.orders);
  }
  const out = sink(['customers', 'customer_addresses']);
  for (const [id, c] of byId) {
    const r = new Rng(cfg.seed, STREAM.CUSTOMER, id);
    const created = c.first !== null ? c.first - r.int(HOUR, 90 * DAY) : tctx.startTs + Math.floor(r.next() * (tctx.endTs - tctx.startTs));
    const [first, last] = personName(r);
    const segment = c.orders >= 3 ? 4 : c.orders === 2 ? 3 : c.orders === 1 ? 2 : 1;
    out.customers.push([
      id, `C${base36(id, 11)}`, first, last, `${slug(first).replace(/_/g, '.')}.${slug(last).replace(/_/g, '.')}.${id}@example.com`,
      `+55 00 9${r.int(1000, 9999)}-${r.int(1000, 9999)}`, r.chance(0.85) ? fmt(created - r.int(18 * 365, 75 * 365) * DAY).slice(0, 10) : null,
      segment, 'active', r.chance(0.45) ? 1 : 0, fmt(created),
    ]);
    c.zips.slice(0, 250).forEach((zip, i) => {
      const a = streetAddress(r, zip);
      out.customer_addresses.push([id, i + 1, i === 0 ? 'both' : 'shipping', a.street, a.number, r.chance(0.3) ? `Apto ${r.int(11, 1804)}` : null, a.district, a.zip, locations.get(zip).id, i === 0 ? 1 : 0, fmt(created)]);
    });
  }
  const counts = {};
  await insertAll(conn, out, ['customers', 'customer_addresses'], counts, cfg.batchSize);
  return counts;
}

// ---------------------------------------------------------------- phase: sellers

async function runSellerUnit(conn, cfg, tctx, lookups, unit) {
  const lo = unit * cfg.commitInterval + 1;
  const hi = (unit + 1) * cfg.commitInterval;
  const rows = await conn.query(
    `SELECT m.target_id AS id, s.zip_prefix,
            (SELECT MIN(o.purchased_at) FROM stg_olist_order_items i JOIN stg_olist_orders o ON o.order_id = i.order_id WHERE i.seller_id = s.seller_id) AS first_sale,
            (SELECT AVG(rv.score) FROM stg_olist_order_items i JOIN stg_olist_reviews rv ON rv.order_id = i.order_id WHERE i.seller_id = s.seller_id) AS rating
       FROM map_olist_ids m
       JOIN stg_olist_sellers s ON s.src_row = (SELECT MIN(s2.src_row) FROM stg_olist_sellers s2 WHERE s2.seller_id = m.source_key)
      WHERE m.entity = 'seller' AND m.target_id BETWEEN ? AND ?
      ORDER BY m.target_id`,
    [lo, hi],
  );
  const locations = await lookups.locations();
  const warehouses = await lookups.warehouses();
  const out = sink(['sellers', 'seller_addresses']);
  for (const s of rows) {
    const r = new Rng(cfg.seed, STREAM.SELLER, s.id);
    const loc = locations.get(s.zip_prefix);
    const firstSale = toTs(s.first_sale) ?? tctx.endTs;
    const created = firstSale - r.int(30, 400) * DAY;
    const rating = s.rating == null ? clamp(4.2 + r.normal() * 0.3, 1, 5) : clamp(Number(s.rating), 1, 5);
    out.sellers.push([
      s.id, `S${base36(s.id, 11)}`, `${r.pick(REF.LAST_NAMES)} & ${r.pick(REF.LAST_NAMES)} Comércio Ltda`,
      `${r.pick(REF.SELLER_WORDS)} ${r.pick(REF.SELLER_NAMES)}`, `contato.s${s.id}@example.net`, `+55 00 3${r.int(100, 999)}-${r.int(1000, 9999)}`,
      rating.toFixed(2), 'active', nearest(warehouses, loc.lat, loc.lng).id, fmt(created),
    ]);
    const a = streetAddress(r, s.zip_prefix);
    out.seller_addresses.push([s.id, 1, 'registered', a.street, a.number, a.district, a.zip, loc.id]);
  }
  const counts = {};
  await insertAll(conn, out, ['sellers', 'seller_addresses'], counts, cfg.batchSize);
  return counts;
}

// ---------------------------------------------------------------- phase: products (listings)

async function runProductUnit(conn, cfg, tctx, lookups, unit) {
  const lo = unit * cfg.commitInterval + 1;
  const hi = (unit + 1) * cfg.commitInterval;
  const rows = await conn.query(
    `SELECT m.target_id AS id, se.seller_id, se.created_at AS seller_created, se.home_warehouse_id AS wh,
            p.category_name, p.name_length, p.description_length, p.photos_qty, p.weight_g, p.length_cm, p.height_cm, p.width_cm,
            (SELECT AVG(i.price) FROM stg_olist_order_items i WHERE i.product_id = LEFT(m.source_key, 32) AND i.seller_id = RIGHT(m.source_key, 32)) AS avg_price,
            (SELECT MIN(o.purchased_at) FROM stg_olist_order_items i JOIN stg_olist_orders o ON o.order_id = i.order_id
              WHERE i.product_id = LEFT(m.source_key, 32) AND i.seller_id = RIGHT(m.source_key, 32)) AS first_sale,
            (SELECT COUNT(*) FROM stg_olist_order_items i WHERE i.product_id = LEFT(m.source_key, 32) AND i.seller_id = RIGHT(m.source_key, 32)) AS units
       FROM map_olist_ids m
       JOIN map_olist_ids sm ON sm.entity = 'seller' AND sm.source_key = RIGHT(m.source_key, 32)
       JOIN sellers se ON se.seller_id = sm.target_id
       JOIN stg_olist_products p ON p.src_row = (SELECT MIN(p2.src_row) FROM stg_olist_products p2 WHERE p2.product_id = LEFT(m.source_key, 32))
      WHERE m.entity = 'listing' AND m.target_id BETWEEN ? AND ?
      ORDER BY m.target_id`,
    [lo, hi],
  );
  const categories = await lookups.categories();
  const catName = new Map((await conn.query('SELECT category_id, category_name FROM product_categories WHERE depth = 1')).map((c) => [c.category_id, c.category_name]));
  const out = sink(['products', 'product_attributes', 'inventory', 'inventory_movements']);
  const counts = {};
  for (const p of rows) {
    const r = new Rng(cfg.seed, STREAM.PRODUCT, p.id);
    const categoryId = categories.get(p.category_name ?? '');
    // Olist has no list price: use the listing's average selling price (min 0.02 so cost < list holds).
    const list = Math.max(2, cents(p.avg_price));
    const cost = clamp(Math.round(list * 0.6), 1, list - 1);
    const sellerCreated = toTs(p.seller_created);
    const firstSale = toTs(p.first_sale) ?? tctx.endTs;
    const created = sellerCreated + Math.floor((firstSale - sellerCreated) * r.between(0.3, 0.95));
    const dim = (v, fallback, key) => {
      if (v > 0) return Math.min(v, 65535);
      bump(counts, `_fix|product_${key}_defaulted`);
      return fallback;
    };
    out.products.push([
      p.id, `OL${base36(p.id, 10)}`, p.seller_id, categoryId, `${catName.get(categoryId)} item ${base36(p.id, 6)}`,
      money(list), money(cost), dim(p.weight_g, 500, 'weight'), dim(p.length_cm, 20, 'dimensions'),
      dim(p.height_cm, 10, 'dimensions'), dim(p.width_cm, 15, 'dimensions'), 'active', fmt(created),
    ]);
    for (const [name, v] of [['photos_qty', p.photos_qty], ['name_length', p.name_length], ['description_length', p.description_length]]) {
      if (v != null) out.product_attributes.push([p.id, name, String(v)]);
    }
    const units = Number(p.units);
    const months = Math.max(1, (tctx.endTs - tctx.startTs) / (30 * DAY));
    out.inventory.push([p.id, p.wh, 0, Math.max(2, Math.ceil((units / months) * 0.6)), fmt(created)]);
    out.inventory_movements.push([p.id, p.wh, 'opening', units + r.int(5, 30), null, fmt(created), 'Opening stock']);
  }
  await insertAll(conn, out, ['products', 'product_attributes', 'inventory', 'inventory_movements'], counts, cfg.batchSize);
  return counts;
}

// ---------------------------------------------------------------- phase: orders

const STATUS = { delivered: 'delivered', shipped: 'shipped', canceled: 'canceled', unavailable: 'unavailable', invoiced: 'approved', processing: 'approved', approved: 'approved', created: 'created' };
const CARRIER = Object.fromEntries(REF.CARRIERS.map((c) => [c[1], { id: c[0], name: c[2].replace(' (fictional)', '') }]));
const RATING_TITLES = REF.REVIEW_TITLES;

function chooseCarrier(r, from, to) {
  if (from.city === to.city && from.state === to.state && r.chance(0.3)) return CARRIER.METROCOUR;
  const w = [0.5, 0.28, to.region === 'North' || to.region === 'Northeast' ? 0.3 : 0.03, to.region === 'South' ? 0.3 : 0.04];
  return [CARRIER.ECONOLOG, CARRIER.SWIFTBR, CARRIER.NORTEVIA, CARRIER.SULTRANS][r.weighted(cumulative(w))];
}

function group(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.id)) m.set(r.id, []);
    m.get(r.id).push(r);
  }
  return m;
}

async function runOrderUnit(conn, cfg, tctx, lookups, unit) {
  const lo = unit * cfg.commitInterval + 1;
  const hi = (unit + 1) * cfg.commitInterval;
  const range = [lo, hi];
  const orders = await conn.query(
    `SELECT m.target_id AS id, o.status, o.purchased_at, o.approved_at, o.carrier_at, o.delivered_at, o.estimated_at,
            cm.target_id AS customer_id, c.zip_prefix
       FROM map_olist_ids m
       JOIN stg_olist_orders o ON o.src_row = (SELECT MIN(o2.src_row) FROM stg_olist_orders o2 WHERE o2.order_id = m.source_key)
       JOIN stg_olist_customers c ON c.src_row = (SELECT MIN(c2.src_row) FROM stg_olist_customers c2 WHERE c2.customer_id = o.customer_id)
       JOIN map_olist_ids cm ON cm.entity = 'customer' AND cm.source_key = c.customer_unique_id
      WHERE m.entity = 'order' AND m.target_id BETWEEN ? AND ?
      ORDER BY m.target_id`,
    range,
  );
  if (!orders.length) return {};
  const items = group(
    await conn.query(
      `SELECT m.target_id AS id, i.item_seq, i.price, i.freight, lm.target_id AS product_id, p.seller_id, p.weight_g, se.home_warehouse_id AS wh, sz.zip_prefix AS seller_zip
         FROM map_olist_ids m
         JOIN stg_olist_order_items i ON i.order_id = m.source_key
         LEFT JOIN map_olist_ids lm ON lm.entity = 'listing' AND lm.source_key = CONCAT(i.product_id, i.seller_id)
         LEFT JOIN products p ON p.product_id = lm.target_id
         LEFT JOIN sellers se ON se.seller_id = p.seller_id
         LEFT JOIN seller_addresses sa ON sa.seller_id = se.seller_id AND sa.address_seq = 1
         LEFT JOIN geographic_locations sz ON sz.location_id = sa.location_id
        WHERE m.entity = 'order' AND m.target_id BETWEEN ? AND ?
        ORDER BY m.target_id, i.item_seq, i.src_row`,
      range,
    ),
  );
  const payments = group(
    await conn.query(
      `SELECT m.target_id AS id, p.payment_seq, p.payment_type, p.installments, p.amount
         FROM map_olist_ids m JOIN stg_olist_payments p ON p.order_id = m.source_key
        WHERE m.entity = 'order' AND m.target_id BETWEEN ? AND ?
        ORDER BY m.target_id, p.payment_seq, p.src_row`,
      range,
    ),
  );
  const reviews = group(
    await conn.query(
      `SELECT m.target_id AS id, r.score, r.title, r.message, r.created_at, r.answered_at
         FROM map_olist_ids m JOIN stg_olist_reviews r ON r.order_id = m.source_key
        WHERE m.entity = 'order' AND m.target_id BETWEEN ? AND ?
        ORDER BY m.target_id, r.created_at DESC, r.src_row DESC`,
      range,
    ),
  );
  const customerIds = [...new Set(orders.map((o) => o.customer_id))];
  const addressSeq = new Map();
  for (const a of await conn.query(
    `SELECT a.customer_id, a.address_seq, g.zip_prefix FROM customer_addresses a JOIN geographic_locations g ON g.location_id = a.location_id
      WHERE a.customer_id IN (${customerIds.map(() => '?').join(',')})`,
    customerIds,
  )) {
    addressSeq.set(`${a.customer_id}|${a.zip_prefix}`, a.address_seq);
  }
  const locations = await lookups.locations();
  const warehouses = new Map((await lookups.warehouses()).map((w) => [w.id, w]));

  const out = sink(ORDER_TABLES);
  const counts = {};
  const fix = (k) => bump(counts, `_fix|${k}`);

  for (const o of orders) {
    const id = o.id;
    const r = new Rng(cfg.seed, STREAM.ORDER, id);
    const dest = locations.get(o.zip_prefix);
    const seqAddr = addressSeq.get(`${o.customer_id}|${o.zip_prefix}`);

    // Lines: one Olist row = one unit; rows with unknown listings are dropped.
    const lines = [];
    const seen = new Set();
    for (const it of items.get(id) || []) {
      if (it.product_id == null) {
        fix('item_dropped_unknown_listing');
        continue;
      }
      if (seen.has(it.item_seq)) {
        fix('item_duplicate_dropped');
        continue;
      }
      seen.add(it.item_seq);
      lines.push({ seq: it.item_seq, productId: it.product_id, sellerId: it.seller_id, wh: it.wh, weight: it.weight_g, sellerZip: it.seller_zip, price: cents(it.price), freight: cents(it.freight) });
    }
    const subtotal = lines.reduce((s, l) => s + l.price, 0);
    const shipping = lines.reduce((s, l) => s + l.freight, 0);
    const total = subtotal + shipping;

    // Lifecycle with repairs.
    let status = STATUS[o.status];
    if (status !== o.status) fix(`status_${o.status}_as_${status}`);
    const P = toTs(o.purchased_at);
    let A = toTs(o.approved_at);
    let C = toTs(o.carrier_at);
    let D = toTs(o.delivered_at);
    const E = toTs(o.estimated_at) ?? P + 20 * DAY;
    if (A === null && ['approved', 'shipped', 'delivered'].includes(status)) {
      A = P;
      fix('approval_time_missing');
    }
    if (A !== null && A < P) {
      A = P;
      fix('approval_before_purchase');
    }
    let canceledAt = null;
    if (status === 'canceled' || status === 'unavailable') {
      canceledAt = Math.max(P, A ?? P) + HOUR;
      if (C !== null || D !== null) fix('canceled_order_delivery_dates_removed');
      C = null;
      D = null;
    }
    if (status === 'approved' && C !== null) {
      status = 'shipped';
      fix('approved_with_pickup_as_shipped');
    }
    if (status === 'delivered' && D === null) {
      status = 'shipped';
      fix('delivered_without_date_as_shipped');
    }
    if ((status === 'shipped' || status === 'delivered') && C === null) {
      C = D !== null ? Math.min(A + DAY, D) : A + DAY;
      fix('pickup_time_missing');
    }
    if (C !== null && C < A) {
      C = A;
      fix('pickup_before_approval');
    }
    if (status === 'delivered' && D < C) {
      D = C;
      fix('delivery_before_pickup');
    }
    if (status !== 'delivered' && D !== null) {
      D = null;
      fix('delivery_date_removed');
    }
    if (status === 'created' || status === 'approved') C = null;

    out.orders.push([
      id, `O${base36(id, 13)}`, o.customer_id, seqAddr, status, 'BRL', money(subtotal), money(shipping), '0.00', money(total), fmt(P),
      fmt(A), A !== null ? fmt(E) : null, status === 'delivered' ? fmt(D) : null, fmt(canceledAt),
    ]);

    // Shipments: one per seller for picked-up orders.
    const shipmentOf = new Map();
    if (status === 'shipped' || status === 'delivered') {
      for (const l of lines) {
        if (!shipmentOf.has(l.sellerId)) shipmentOf.set(l.sellerId, { seq: shipmentOf.size + 1, lines: [], wh: l.wh, sellerZip: l.sellerZip });
        shipmentOf.get(l.sellerId).lines.push(l);
      }
      for (const [sellerId, sh] of shipmentOf) {
        const from = locations.get(sh.sellerZip) || dest;
        const carrier = chooseCarrier(r, from, dest);
        const delivered = status === 'delivered';
        out.shipments.push([
          id, sh.seq, sellerId, sh.wh, carrier.id, `OL${base36(id, 9)}${sh.seq}BR`, delivered ? 'delivered' : 'in_transit',
          money(sh.lines.reduce((s, l) => s + l.freight, 0)), sh.lines.reduce((s, l) => s + (l.weight || 500), 0), dest.id,
          fmt(A), fmt(C), fmt(E), delivered ? fmt(D) : null,
        ]);
        const whLoc = warehouses.get(sh.wh)?.locationId ?? dest.id;
        const events = [['label_created', A, whLoc, 'Shipping label created'], ['picked_up', C, whLoc, `Picked up by ${carrier.name}`]];
        if (delivered) events.push(['delivered', D, dest.id, 'Delivered to recipient']);
        events.forEach(([type, at, loc, desc], k) => out.shipment_tracking_events.push([id, sh.seq, k + 1, type, fmt(at), loc, desc]));
        for (const l of sh.lines) out.inventory_movements.push([l.productId, l.wh, 'sale', -1, id, fmt(C), null]);
      }
    }
    for (const l of lines) out.order_items.push([id, l.seq, l.productId, shipmentOf.get(l.sellerId)?.seq ?? null, 1, money(l.price), money(l.freight)]);

    // Payments, reconciled to the order total.
    let pays = [];
    for (const p of payments.get(id) || []) {
      if (p.payment_type === 'not_defined' || cents(p.amount) <= 0) {
        fix('payment_without_value_or_type_dropped');
        continue;
      }
      pays.push({ method: p.payment_type, installments: p.payment_type === 'credit_card' ? clamp(Number(p.installments) || 1, 1, 24) : 1, amount: cents(p.amount) });
    }
    if (!pays.length) {
      pays = [{ method: 'credit_card', installments: 1, amount: total }];
      fix('payment_synthesized');
    } else {
      const diff = total - pays.reduce((s, p) => s + p.amount, 0);
      if (diff !== 0) {
        const last = pays[pays.length - 1];
        if (last.amount + diff > 0) {
          last.amount += diff;
          fix('payment_adjusted_to_total');
        } else {
          const main = pays.reduce((a, b) => (b.amount > a.amount ? b : a));
          pays = [{ ...main, amount: total }];
          fix('payments_replaced_by_total');
        }
        bump(counts, '_stat|payment_adjustment_cents', Math.abs(diff));
      }
    }
    const refundAt = canceledAt !== null && A !== null ? canceledAt + HOUR : null;
    pays.forEach((p, i) => {
      const seq = i + 1;
      let pstatus;
      const txns = [];
      if (A !== null) {
        if (p.method === 'boleto') txns.push(['authorization', 'success', p.amount, P]);
        else if (p.method === 'credit_card' || p.method === 'debit_card') txns.push(['authorization', 'success', p.amount, A]);
        txns.push(['capture', 'success', p.amount, A]);
        if (refundAt !== null) txns.push(['refund', 'success', p.amount, refundAt]);
        pstatus = refundAt !== null ? 'refunded' : 'captured';
      } else if (canceledAt !== null) {
        if (p.method === 'boleto') txns.push(['authorization', 'success', p.amount, P]);
        txns.push(['void', 'success', p.amount, canceledAt]);
        pstatus = 'voided';
      } else {
        if (p.method === 'boleto') txns.push(['authorization', 'success', p.amount, P]);
        pstatus = 'pending';
      }
      out.payments.push([id, seq, p.method, p.installments, money(p.amount), pstatus, fmt(P), fmt(A)]);
      txns.forEach(([type, ts, amount, at], k) => out.payment_transactions.push([id, seq, k + 1, type, ts, money(amount), `OL-${base36(id, 10)}-${seq}-${k + 1}`, fmt(at)]));
    });

    // Latest review, on the first line, for delivered orders only.
    const rv = (reviews.get(id) || [])[0];
    if (rv) {
      if ((reviews.get(id) || []).length > 1) bump(counts, '_skip|older_reviews_of_same_order', reviews.get(id).length - 1);
      if (status !== 'delivered') {
        fix('review_of_undelivered_order_dropped');
      } else {
        let created = toTs(rv.created_at) ?? D + DAY;
        if (created < D) {
          created = D + HOUR;
          fix('review_moved_after_delivery');
        }
        let answered = toTs(rv.answered_at);
        if (answered !== null && answered < created) {
          answered = created + HOUR;
          fix('review_answer_moved_after_review');
        }
        const score = clamp(Number(rv.score), 1, 5);
        out.product_reviews.push([id, lines[0].seq, score, (rv.title || r.pick(RATING_TITLES[score])).slice(0, 120), rv.message ? rv.message.slice(0, 500) : null, fmt(created), fmt(answered)]);
      }
    }
  }
  await insertAll(conn, out, ORDER_TABLES, counts, cfg.batchSize);
  return counts;
}

// ---------------------------------------------------------------- phases

export async function transformWindow() {
  const [w] = await query(
    `SELECT MIN(purchased_at) AS first_purchase, MAX(purchased_at) AS last_purchase,
            GREATEST(COALESCE(MAX(purchased_at), '2000-01-01'), COALESCE(MAX(approved_at), '2000-01-01'),
                     COALESCE(MAX(carrier_at), '2000-01-01'), COALESCE(MAX(delivered_at), '2000-01-01')) AS last_event,
            (SELECT GREATEST(COALESCE(MAX(created_at), '2000-01-01'), COALESCE(MAX(answered_at), '2000-01-01')) FROM stg_olist_reviews) AS last_review
       FROM stg_olist_orders`,
  );
  if (!w.first_purchase) return null;
  const startTs = toTs(w.first_purchase);
  const endTs = Math.max(toTs(w.last_event), toTs(w.last_review)) + 2 * DAY;
  return { startTs, endTs, startDate: w.first_purchase.slice(0, 10), endDate: w.last_purchase.slice(0, 10) };
}

export async function buildTransformPhases({ cfg }) {
  const tctx = await transformWindow();
  const lookups = createLookups();
  const units = (entity) => async () => Math.ceil((await countEntity(entity)) / cfg.commitInterval);
  const months = monthStarts({ startDate: tctx.startDate, endDate: tctx.endDate });
  return [
    { key: 'map', label: 'Map Olist ids to lab ids', units: 1, concurrency: 1, run: (conn) => runMapUnit(conn) },
    { key: 'reference', label: 'Reference data, geography & categories', units: 1, concurrency: 1, run: (conn) => runReferenceUnit(conn, cfg) },
    { key: 'customers', label: 'Customers & addresses', units: units('customer'), run: (conn, u) => runCustomerUnit(conn, cfg, tctx, lookups, u) },
    { key: 'sellers', label: 'Sellers & addresses', units: units('seller'), run: (conn, u) => runSellerUnit(conn, cfg, tctx, lookups, u) },
    { key: 'products', label: 'Product listings, attributes & opening stock', units: units('listing'), run: (conn, u) => runProductUnit(conn, cfg, tctx, lookups, u) },
    { key: 'orders', label: 'Orders, items, shipments, payments & reviews', units: units('order'), run: (conn, u) => runOrderUnit(conn, cfg, tctx, lookups, u) },
    {
      key: 'stock', label: 'Inventory balances', units: units('listing'),
      run: async (conn, u) => runStockUnit(conn, { cfg: { commitInterval: cfg.commitInterval, products: await countEntity('listing') }, endTs: tctx.endTs }, u),
    },
    { key: 'summaries', label: 'Sales summary tables', units: months.length, run: (conn, u) => runSummaryUnit(conn, months, u) },
  ];
}
