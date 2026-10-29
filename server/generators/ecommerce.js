// Synthetic e-commerce model. Every builder is a pure function of
// (configuration, seed, entity id): it can be called for any id, in any order,
// on any worker, and returns the same rows. Cross-entity references are resolved
// by recomputing the referenced entity's "core" attributes, never by reading the
// database, so batches have no hidden ordering dependencies beyond FK phases.
//
// Money is handled in integer cents and formatted only when rows are emitted.
// Timestamps are integer UTC epoch seconds.
import { Rng, Permutation, cumulative, hash3 } from './prng.js';
import * as REF from './reference-data.js';
import { applyCalibration, paymentWeights } from './calibrationProfile.js';

export const GENERATOR_VERSION = 1;
export const DAY = 86400;
const HOUR = 3600;
const YEAR = 365 * DAY;

export const STREAM = {
  CUSTOMER: 1, CUSTOMER_DETAIL: 2, SELLER: 3, SELLER_DETAIL: 4, PRODUCT: 5, PRODUCT_DETAIL: 6,
  PROMOTION: 7, ORDER: 8, CART: 9, MOVEMENT: 10, PERM_CUSTOMER: 11, PERM_PRODUCT: 12,
  PERM_SELLER: 13, SEASON: 14, PERM_CART_ORDER: 15, PERM_FIRST_ORDER: 16,
};

// Column lists define the row-array layout produced by the builders.
export const COLUMNS = {
  currencies: ['currency_code', 'currency_name', 'symbol', 'decimal_places', 'rate_to_brl'],
  geographic_locations: ['location_id', 'zip_prefix', 'city', 'state_code', 'state_name', 'region', 'latitude', 'longitude'],
  customer_segments: ['segment_id', 'segment_code', 'segment_name', 'description'],
  shipping_carriers: ['carrier_id', 'carrier_code', 'carrier_name', 'service_level', 'base_rate', 'per_kg_rate', 'avg_transit_days', 'is_active'],
  warehouses: ['warehouse_id', 'warehouse_code', 'warehouse_name', 'location_id', 'capacity_units', 'opened_at'],
  product_categories: ['category_id', 'parent_category_id', 'category_code', 'category_name', 'depth'],
  customers: ['customer_id', 'customer_code', 'first_name', 'last_name', 'email', 'phone', 'birth_date', 'segment_id', 'status', 'marketing_opt_in', 'created_at'],
  customer_addresses: ['customer_id', 'address_seq', 'address_type', 'street', 'street_number', 'complement', 'district', 'zip_code', 'location_id', 'is_default', 'created_at'],
  sellers: ['seller_id', 'seller_code', 'legal_name', 'display_name', 'email', 'phone', 'rating', 'status', 'home_warehouse_id', 'created_at'],
  seller_addresses: ['seller_id', 'address_seq', 'address_type', 'street', 'street_number', 'district', 'zip_code', 'location_id'],
  products: ['product_id', 'sku', 'seller_id', 'category_id', 'product_name', 'list_price', 'cost_price', 'weight_g', 'length_cm', 'height_cm', 'width_cm', 'status', 'created_at'],
  product_attributes: ['product_id', 'attribute_name', 'attribute_value'],
  promotions: ['promotion_id', 'promotion_code', 'promotion_name', 'discount_type', 'discount_value', 'max_discount', 'min_order_amount', 'starts_at', 'ends_at'],
  inventory: ['product_id', 'warehouse_id', 'quantity_on_hand', 'reorder_level', 'updated_at'],
  orders: ['order_id', 'order_code', 'customer_id', 'shipping_address_seq', 'status', 'currency_code', 'items_subtotal', 'shipping_total', 'discount_total', 'total_amount', 'purchased_at', 'approved_at', 'estimated_delivery_at', 'delivered_at', 'canceled_at'],
  shipments: ['order_id', 'shipment_seq', 'seller_id', 'warehouse_id', 'carrier_id', 'tracking_number', 'status', 'shipping_cost', 'weight_g', 'destination_location_id', 'created_at', 'shipped_at', 'estimated_delivery_at', 'delivered_at'],
  order_items: ['order_id', 'item_seq', 'product_id', 'shipment_seq', 'quantity', 'unit_price', 'freight_amount'],
  shipment_tracking_events: ['order_id', 'shipment_seq', 'event_seq', 'event_type', 'event_at', 'location_id', 'description'],
  payments: ['order_id', 'payment_seq', 'payment_method', 'installments', 'amount', 'status', 'created_at', 'captured_at'],
  payment_transactions: ['order_id', 'payment_seq', 'txn_seq', 'txn_type', 'txn_status', 'amount', 'processor_ref', 'created_at'],
  order_returns: ['order_id', 'return_seq', 'status', 'reason', 'requested_at', 'received_at', 'refunded_at', 'refund_amount'],
  return_items: ['order_id', 'return_seq', 'item_seq', 'quantity', 'item_condition'],
  product_reviews: ['order_id', 'item_seq', 'rating', 'title', 'comment', 'created_at', 'answered_at'],
  promotion_redemptions: ['order_id', 'promotion_id', 'discount_amount', 'redeemed_at'],
  shopping_carts: ['cart_id', 'customer_id', 'status', 'converted_order_id', 'created_at', 'updated_at'],
  shopping_cart_items: ['cart_id', 'product_id', 'quantity', 'unit_price', 'added_at'],
  inventory_movements: ['product_id', 'warehouse_id', 'movement_type', 'quantity', 'order_id', 'moved_at', 'note'],
};

// Tables written by the order builder, in foreign-key insert order.
export const ORDER_TABLES = [
  'orders', 'shipments', 'order_items', 'shipment_tracking_events', 'payments', 'payment_transactions',
  'order_returns', 'return_items', 'product_reviews', 'promotion_redemptions', 'inventory_movements',
];

export function newSink(tables) {
  const sink = {};
  for (const t of tables) sink[t] = [];
  return sink;
}

// ---------------------------------------------------------------- formatting

export function money(cents) {
  const sign = cents < 0 ? '-' : '';
  const c = Math.abs(cents);
  return `${sign}${Math.trunc(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

export function fmtTs(ts) {
  return ts == null ? null : new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function fmtDate(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function base36(n, width) {
  return n.toString(36).toUpperCase().padStart(width, '0');
}

function slug(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '.');
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------- context

export function createContext(cfg) {
  const seed = cfg.seed >>> 0;
  const startTs = Date.parse(`${cfg.startDate}T00:00:00Z`) / 1000;
  const endTs = Date.parse(`${cfg.endDate}T23:59:59Z`) / 1000;
  const days = Math.floor((endTs - startTs) / DAY) + 1;

  const locations = REF.buildLocations();
  const locIndexByCity = new Map();
  const locIndexesByState = new Map();
  locations.forEach((l, i) => {
    const key = `${l.state}|${l.city}`;
    if (!locIndexByCity.has(key)) locIndexByCity.set(key, []);
    locIndexByCity.get(key).push(i);
    if (!locIndexesByState.has(l.state)) locIndexesByState.set(l.state, []);
    locIndexesByState.get(l.state).push(i);
  });

  const warehouses = REF.WAREHOUSES.map(([id, code, name, city, state, capacity, opened]) => ({
    id, code, name, capacity, opened, locIdx: locIndexByCity.get(`${state}|${city}`)[0],
  }));
  const nearestWarehouse = locations.map((l) => {
    let best = null;
    let bestD = Infinity;
    for (const w of warehouses) {
      const wl = locations[w.locIdx];
      const dx = (wl.lng - l.lng) * Math.cos((l.lat * Math.PI) / 180);
      const dy = wl.lat - l.lat;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = w;
      }
    }
    return best;
  });

  const carriers = REF.CARRIERS.map(([id, code, name, level, base, perKg, median]) => ({ id, code, name, level, base, perKg, median }));

  // Categories: all parents, then the requested number of leaves.
  const parents = REF.CATEGORY_PARENTS.map(([code, name], i) => ({ id: i + 1, code, name }));
  const parentId = new Map(parents.map((p) => [p.code, p.id]));
  const baseLeaves = REF.CATEGORY_LEAVES.map(([code, name, parent, weight, price, sigma, weightG, nouns, attrSet]) => ({
    code, name, parent, weight, price, sigma, weightG, nouns, attrSet,
  })).sort((a, b) => b.weight - a.weight);
  const leaves = [];
  for (let j = 0; j < cfg.categories; j++) {
    if (j < baseLeaves.length) {
      leaves.push({ ...baseLeaves[j] });
    } else {
      const k = j - baseLeaves.length;
      const base = baseLeaves[k % baseLeaves.length];
      const round = Math.floor(k / baseLeaves.length);
      const variant = REF.CATEGORY_VARIANTS[round % REF.CATEGORY_VARIANTS.length];
      const suffix = round >= REF.CATEGORY_VARIANTS.length ? ` ${Math.floor(round / REF.CATEGORY_VARIANTS.length) + 1}` : '';
      leaves.push({
        ...base,
        code: `${base.code}_${slug(variant + suffix).replace(/\./g, '_')}`,
        name: `${base.name} ${variant}${suffix}`,
        weight: base.weight * 0.25,
      });
    }
  }
  leaves.forEach((l, i) => {
    l.id = parents.length + i + 1;
    l.parentId = parentId.get(l.parent);
  });
  if (cfg.calibration) applyCalibration(cfg.calibration, leaves, locations);

  // Seasonal purchase-date distribution.
  const dayWeights = new Float64Array(days);
  const years = new Set();
  for (let d = 0; d < days; d++) years.add(new Date((startTs + d * DAY) * 1000).getUTCFullYear());
  const blackFridays = [...years].map(blackFriday);
  const mothersDays = [...years].map(mothersDay);
  const MONTH = [0.88, 0.9, 1.0, 0.97, 1.05, 0.98, 0.98, 1.02, 0.97, 1.0, 1.18, 1.12];
  const WEEKDAY = [0.86, 1.12, 1.1, 1.06, 1.02, 0.97, 0.82];
  for (let d = 0; d < days; d++) {
    const ts = startTs + d * DAY;
    const dt = new Date(ts * 1000);
    const m = dt.getUTCMonth();
    const dom = dt.getUTCDate();
    let w = (0.55 + 0.9 * (d / Math.max(1, days - 1))) * MONTH[m] * WEEKDAY[dt.getUTCDay()];
    for (const bf of blackFridays) {
      const diff = Math.round((ts - bf) / DAY);
      if (diff === 0) w *= 4;
      else if (diff === -1 || diff === 1 || diff === 2) w *= 1.7;
      else if (diff === 3) w *= 2;
    }
    for (const md of mothersDays) {
      const diff = Math.round((md - ts) / DAY);
      if (diff >= 1 && diff <= 7) w *= 1.35;
    }
    if (m === 11 && dom <= 22) w *= 1.25;
    if (m === 11 && dom >= 24) w *= 0.75;
    w *= 1 + 0.12 * ((hash3(seed, STREAM.SEASON, d) / 4294967296) * 2 - 1);
    dayWeights[d] = w;
  }
  const HOURS = [2.0, 1.0, 0.5, 0.3, 0.2, 0.3, 0.9, 2.3, 4.6, 6.0, 6.6, 6.7, 6.2, 6.6, 6.7, 6.4, 6.4, 6.2, 5.8, 5.8, 6.2, 6.5, 6.1, 4.5];

  // Seller catalogues: contiguous product id ranges with power-law sizes.
  const S = cfg.sellers;
  const P = cfg.products;
  const sellerPerm = new Permutation(S, seed, STREAM.PERM_SELLER);
  const sizes = new Float64Array(S);
  let wsum = 0;
  for (let s = 0; s < S; s++) {
    sizes[s] = 1 / Math.pow(sellerPerm.indexToRank(s) + 1, 0.85);
    wsum += sizes[s];
  }
  let assigned = 0;
  for (let s = 0; s < S; s++) {
    sizes[s] = Math.floor((P * sizes[s]) / wsum);
    assigned += sizes[s];
  }
  for (let s = 0; assigned < P; s = (s + 1) % S) {
    sizes[s]++;
    assigned++;
  }
  if (sizes[0] === 0) {
    let big = 0;
    for (let s = 1; s < S; s++) if (sizes[s] > sizes[big]) big = s;
    sizes[big]--;
    sizes[0] = 1;
  }
  const sellerCum = new Float64Array(S);
  let acc = 0;
  for (let s = 0; s < S; s++) {
    acc += sizes[s];
    sellerCum[s] = acc;
  }

  const ctx = {
    cfg, seed, startTs, endTs, days,
    locations, locIndexByCity, locIndexesByState, nearestWarehouse, warehouses, carriers,
    parents, leaves,
    leafCdf: cumulative(leaves.map((l) => l.weight)),
    custLocCdf: cumulative(locations.map((l) => l.customerWeight)),
    sellerLocCdf: cumulative(locations.map((l) => l.sellerWeight)),
    dayCdf: cumulative(dayWeights),
    hourCdf: cumulative(HOURS),
    blackFridays,
    customerPerm: new Permutation(cfg.customers, seed, STREAM.PERM_CUSTOMER),
    productPerm: new Permutation(P, seed, STREAM.PERM_PRODUCT),
    cartOrderPerm: cfg.orders > 0 ? new Permutation(cfg.orders, seed, STREAM.PERM_CART_ORDER) : null,
    sellerCum,
    launchSellers: Math.max(1, Math.ceil(S * 0.4)),
    productZipf: 0.85,
    customerZipf: 0.75,
    firstPurchaseShare: 0.72,
    firstOrderPerm: new Permutation(cfg.customers, seed, STREAM.PERM_FIRST_ORDER),
    caches: { customer: new Map(), seller: new Map(), product: new Map() },
    methodCdf: cumulative(cfg.calibration ? paymentWeights(cfg.calibration) : [0.7, 0.18, 0.06, 0.04, 0.02]),
  };

  // Promotions active on each day of the window, so orders can redeem a live one.
  ctx.promotionsByDay = Array.from({ length: days }, () => []);
  for (let id = 1; id <= cfg.promotions; id++) {
    const p = promotionCore(ctx, id);
    const from = Math.max(0, Math.floor((p.startsAt - startTs) / DAY));
    const to = Math.min(days - 1, Math.floor((p.endsAt - startTs) / DAY));
    for (let d = from; d <= to; d++) ctx.promotionsByDay[d].push(id);
  }
  return ctx;
}

const METHODS = ['credit_card', 'boleto', 'pix', 'voucher', 'debit_card'];

function blackFriday(year) {
  // Fourth Friday of November.
  const nov1 = Date.UTC(year, 10, 1) / 1000;
  const dow = new Date(nov1 * 1000).getUTCDay();
  const firstFriday = 1 + ((5 - dow + 7) % 7);
  return nov1 + (firstFriday + 21 - 1) * DAY;
}

function mothersDay(year) {
  // Second Sunday of May.
  const may1 = Date.UTC(year, 4, 1) / 1000;
  const dow = new Date(may1 * 1000).getUTCDay();
  const firstSunday = 1 + ((7 - dow) % 7);
  return may1 + (firstSunday + 7 - 1) * DAY;
}

function cached(map, id, make) {
  let v = map.get(id);
  if (v === undefined) {
    if (map.size >= 200000) map.clear();
    v = make();
    map.set(id, v);
  }
  return v;
}

export function sampleTs(ctx, r) {
  const d = r.weighted(ctx.dayCdf);
  const h = r.weighted(ctx.hourCdf);
  return ctx.startTs + d * DAY + h * HOUR + r.int(0, 3599);
}

function dayStart(ts) {
  return ts - (ts % DAY);
}

// ---------------------------------------------------------------- reference

export function buildReference(ctx) {
  const out = {
    currencies: REF.CURRENCIES.map(([c, n, s, d, rate]) => [c, n, s, d, rate.toFixed(8)]),
    geographic_locations: ctx.locations.map((l) => [l.locationId, l.zipPrefix, l.city, l.state, l.stateName, l.region, l.lat.toFixed(6), l.lng.toFixed(6)]),
    customer_segments: REF.SEGMENTS.map((s) => [...s]),
    shipping_carriers: ctx.carriers.map((c) => [c.id, c.code, c.name, c.level, c.base.toFixed(2), c.perKg.toFixed(2), c.median.toFixed(2), 1]),
    warehouses: ctx.warehouses.map((w) => [w.id, w.code, w.name, ctx.locations[w.locIdx].locationId, w.capacity, w.opened]),
    product_categories: [
      ...ctx.parents.map((p) => [p.id, null, p.code, p.name, 0]),
      ...ctx.leaves.map((l) => [l.id, l.parentId, l.code, l.name, 1]),
    ],
    promotions: [],
  };
  for (let id = 1; id <= ctx.cfg.promotions; id++) out.promotions.push(promotionRow(ctx, id));
  return out;
}

export function promotionCore(ctx, id) {
  const r = new Rng(ctx.seed, STREAM.PROMOTION, id);
  const percent = r.chance(0.7);
  const value = percent ? r.pick([5, 10, 10, 15, 20, 25, 30]) : r.pick([10, 15, 20, 30, 50]) * 100;
  const maxDiscount = percent ? r.pick([50, 80, 100, 150, 300]) * 100 : null;
  const minOrder = r.pick([0, 50, 100, 150, 200]) * 100;
  let startsAt;
  let duration;
  let label;
  if (ctx.blackFridays.length && r.chance(0.2)) {
    startsAt = r.pick(ctx.blackFridays) - 3 * DAY;
    duration = 7 * DAY;
    label = 'Black Friday';
  } else {
    startsAt = dayStart(ctx.startTs - 30 * DAY + Math.floor(r.next() * Math.max(DAY, ctx.endTs - ctx.startTs)));
    duration = r.int(3, 45) * DAY;
    label = r.pick(['Weekend Deal', 'Seasonal Sale', 'Welcome Offer', 'Flash Sale', 'Loyalty Reward', 'Clearance']);
  }
  return { id, percent, value, maxDiscount, minOrder, startsAt, endsAt: startsAt + duration - 1, label };
}

function promotionRow(ctx, id) {
  const p = promotionCore(ctx, id);
  const name = p.percent ? `${p.label} ${p.value}% off` : `${p.label} R$${p.value / 100} off`;
  return [
    id, `SYN${base36(id, 6)}`, name, p.percent ? 'percent' : 'fixed', p.percent ? `${p.value}.00` : money(p.value),
    p.maxDiscount == null ? null : money(p.maxDiscount), money(p.minOrder), fmtTs(p.startsAt), fmtTs(p.endsAt),
  ];
}

// ---------------------------------------------------------------- customers

export function customerCore(ctx, id) {
  return cached(ctx.caches.customer, id, () => {
    const r = new Rng(ctx.seed, STREAM.CUSTOMER, id);
    let createdTs = r.chance(0.35) ? ctx.startTs - r.int(1, 730) * DAY + r.int(0, DAY - 1) : sampleTs(ctx, r);
    if (createdTs > ctx.endTs - 2 * DAY) createdTs = ctx.endTs - 2 * DAY - r.int(0, DAY);
    const nAddr = r.chance(0.75) ? 1 : r.chance(0.88) ? 2 : 3;
    const addrLocs = [r.weighted(ctx.custLocCdf)];
    for (let i = 1; i < nAddr; i++) {
      const first = ctx.locations[addrLocs[0]];
      addrLocs.push(r.chance(0.7) ? r.pick(ctx.locIndexByCity.get(`${first.state}|${first.city}`)) : r.weighted(ctx.custLocCdf));
    }
    const f = ctx.customerPerm.indexToRank(id - 1) / ctx.cfg.customers;
    let segmentId = 2;
    if (f < 0.01) segmentId = 5;
    else if (f < 0.05) segmentId = 4;
    else if (f < 0.2) segmentId = 3;
    else if (createdTs > ctx.endTs - 90 * DAY) segmentId = 1;
    return { id, createdTs, nAddr, addrLocs, segmentId };
  });
}

// Orders: most are a customer's first purchase (an injective mapping from order id
// to customer while ids last), the rest are repeat purchases concentrated on the
// popular customers. Carts (no order id) use the uniform/popular mixture only.
function pickCustomerId(ctx, r, orderId = null) {
  const n = ctx.cfg.customers;
  if (orderId !== null && r.chance(ctx.firstPurchaseShare)) return ctx.firstOrderPerm.rankToIndex((orderId - 1) % n) + 1;
  if (r.chance(0.3)) return r.int(1, n);
  return ctx.customerPerm.rankToIndex(bucketedRank(r, n, ctx.customerZipf, Math.floor(n / 2000))) + 1;
}

// Power-law rank whose head is spread over buckets that grow with the population,
// so the most popular customers and products stay plausible at any dataset size.
function bucketedRank(r, n, s, width) {
  const w = Math.max(1, width);
  const rank = r.zipfRank(n, s);
  return Math.min(n - 1, rank - (rank % w) + r.int(0, w - 1));
}

function address(r, loc) {
  return {
    street: `${r.pick(REF.STREET_TYPES)} ${r.pick(REF.STREET_NAMES)}`,
    number: String(r.int(1, 4999)),
    district: r.pick(REF.DISTRICTS),
    zip: `${loc.zipPrefix}-${String(r.int(0, 999)).padStart(3, '0')}`,
  };
}

export function buildCustomer(ctx, id, out) {
  const c = customerCore(ctx, id);
  const r = new Rng(ctx.seed, STREAM.CUSTOMER_DETAIL, id);
  const first = r.pick(REF.FIRST_NAMES);
  const last = r.chance(0.4) ? `${r.pick(REF.LAST_NAMES)} ${r.pick(REF.LAST_NAMES)}` : r.pick(REF.LAST_NAMES);
  const birth = r.chance(0.85) ? fmtDate(c.createdTs - r.int(18 * 365, 75 * 365) * DAY) : null;
  out.customers.push([
    id, `C${base36(id, 11)}`, first, last, `${slug(first)}.${slug(last)}.${id}@example.com`,
    `+55 00 9${r.int(1000, 9999)}-${r.int(1000, 9999)}`, birth, c.segmentId, r.chance(0.04) ? 'inactive' : 'active',
    r.chance(0.45) ? 1 : 0, fmtTs(c.createdTs),
  ]);
  for (let seq = 1; seq <= c.nAddr; seq++) {
    const loc = ctx.locations[c.addrLocs[seq - 1]];
    const a = address(r, loc);
    out.customer_addresses.push([
      id, seq, seq === 1 ? 'both' : 'shipping', a.street, a.number, r.chance(0.3) ? `Apto ${r.int(11, 1804)}` : null,
      a.district, a.zip, loc.locationId, seq === 1 ? 1 : 0, fmtTs(c.createdTs),
    ]);
  }
}

// ---------------------------------------------------------------- sellers

export function sellerCore(ctx, id) {
  return cached(ctx.caches.seller, id, () => {
    const r = new Rng(ctx.seed, STREAM.SELLER, id);
    const launch = id <= ctx.launchSellers;
    const lo = ctx.startTs - 200 * DAY;
    const createdTs = launch
      ? ctx.startTs - r.int(200, 900) * DAY - r.int(0, DAY - 1)
      : lo + Math.floor(r.next() * (ctx.endTs - 60 * DAY - lo));
    const locIdx = r.weighted(ctx.sellerLocCdf);
    const handlingFactor = clamp(r.lognormal(1, 0.3), 0.5, 3);
    const rating = clamp(4.6 - (handlingFactor - 1) * 1.2 + r.normal() * 0.25, 1, 5);
    return { id, createdTs, locIdx, warehouseId: ctx.nearestWarehouse[locIdx].id, handlingFactor, rating };
  });
}

export function sellerRange(ctx, id) {
  const first = (id > 1 ? ctx.sellerCum[id - 2] : 0) + 1;
  return { first, last: ctx.sellerCum[id - 1], size: ctx.sellerCum[id - 1] - first + 1 };
}

export function sellerOfProduct(ctx, pid) {
  const cum = ctx.sellerCum;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cum[mid] >= pid) hi = mid;
    else lo = mid + 1;
  }
  return lo + 1;
}

export function buildSeller(ctx, id, out) {
  const s = sellerCore(ctx, id);
  const r = new Rng(ctx.seed, STREAM.SELLER_DETAIL, id);
  const loc = ctx.locations[s.locIdx];
  out.sellers.push([
    id, `S${base36(id, 11)}`, `${r.pick(REF.LAST_NAMES)} & ${r.pick(REF.LAST_NAMES)} Comércio Ltda`,
    `${r.pick(REF.SELLER_WORDS)} ${r.pick(REF.SELLER_NAMES)}`, `contato.s${id}@example.net`,
    `+55 00 3${r.int(100, 999)}-${r.int(1000, 9999)}`, s.rating.toFixed(2), r.chance(0.03) ? 'suspended' : 'active',
    s.warehouseId, fmtTs(s.createdTs),
  ]);
  const a = address(r, loc);
  out.seller_addresses.push([id, 1, 'registered', a.street, a.number, a.district, a.zip, loc.locationId]);
  if (r.chance(0.3)) {
    const b = address(r, loc);
    out.seller_addresses.push([id, 2, 'pickup', b.street, b.number, b.district, b.zip, loc.locationId]);
  }
}

// ---------------------------------------------------------------- products

export function productCore(ctx, pid) {
  return cached(ctx.caches.product, pid, () => {
    const sellerId = sellerOfProduct(ctx, pid);
    const s = sellerCore(ctx, sellerId);
    const range = sellerRange(ctx, sellerId);
    const launch = sellerId <= ctx.launchSellers && pid - range.first < Math.ceil(range.size / 2);
    const r = new Rng(ctx.seed, STREAM.PRODUCT, pid);
    const leafIdx = r.weighted(ctx.leafCdf);
    const leaf = ctx.leaves[leafIdx];
    const price = clamp(r.lognormal(leaf.price, leaf.sigma), 5, 20000);
    const listCents = Math.max(490, Math.round(price) * 100 - 10);
    const costCents = Math.max(1, Math.min(listCents - 1, Math.round(listCents * r.between(0.45, 0.75))));
    const weightG = Math.round(clamp(r.lognormal(leaf.weightG, 0.5), 50, 40000));
    let createdTs;
    if (launch) {
      const lo = s.createdTs + DAY;
      createdTs = lo + Math.floor(r.next() * (ctx.startTs - DAY - lo));
    } else {
      const lo = Math.max(s.createdTs + DAY, ctx.startTs - 180 * DAY);
      const hi = ctx.endTs - 30 * DAY;
      createdTs = hi > lo ? lo + Math.floor(r.next() * (hi - lo)) : lo;
    }
    return {
      id: pid, sellerId, warehouseId: s.warehouseId, sellerLocIdx: s.locIdx, leafIdx, categoryId: leaf.id,
      listCents, costCents, weightG, createdTs, rank: ctx.productPerm.indexToRank(pid - 1),
    };
  });
}

// Expected share of order lines that go to a product of the given popularity rank.
function zipfShare(n, s, rank) {
  if (n <= 1) return 1;
  const F = (x) => (Math.pow(x, 1 - s) - 1) / (Math.pow(n, 1 - s) - 1);
  return F(rank + 2) - F(rank + 1);
}

export function buildProduct(ctx, pid, out) {
  const p = productCore(ctx, pid);
  const leaf = ctx.leaves[p.leafIdx];
  const r = new Rng(ctx.seed, STREAM.PRODUCT_DETAIL, pid);
  const adjective = r.chance(0.5) ? r.pick(REF.ADJECTIVES) : r.pick(REF.BRANDS);
  const model = `${String.fromCharCode(65 + r.int(0, 25))}${String.fromCharCode(65 + r.int(0, 25))}-${r.int(100, 999)}`;
  const side = (k) => Math.round(clamp(Math.cbrt(p.weightG * r.between(2, 6)) * k, 2, 200));
  out.products.push([
    pid, `SKU-${base36(pid, 10)}`, p.sellerId, p.categoryId, `${adjective} ${r.pick(leaf.nouns)} ${model}`,
    money(p.listCents), money(p.costCents), p.weightG, side(1.3), side(0.6), side(1.0),
    r.chance(0.03) ? 'discontinued' : 'active', fmtTs(p.createdTs),
  ]);
  const attrs = Object.entries(REF.ATTRIBUTE_SETS[leaf.attrSet]);
  const nAttrs = r.int(2, attrs.length);
  for (let i = 0; i < nAttrs; i++) {
    const [name, values] = attrs[i];
    const pool = values === 'colors' ? REF.COLORS : values === 'brands' ? REF.BRANDS : values;
    out.product_attributes.push([pid, name, r.pick(pool)]);
  }
  const expectedUnits = ctx.cfg.orders * ctx.cfg.avgItemsPerOrder * 1.1 * zipfShare(ctx.cfg.products, ctx.productZipf, p.rank) * 0.5;
  const perMonth = expectedUnits / Math.max(1, ctx.days / 30);
  const reorder = Math.min(5000, Math.max(2, Math.ceil(perMonth * 0.6)));
  out.inventory.push([pid, p.warehouseId, 0, reorder, fmtTs(p.createdTs)]);
  const opening = Math.max(5, Math.ceil(expectedUnits * 0.35)) + r.int(0, 20);
  out.inventory_movements.push([pid, p.warehouseId, 'opening', opening, null, fmtTs(p.createdTs), 'Opening stock']);
}

function pickProduct(ctx, r, ts) {
  const P = ctx.cfg.products;
  for (let i = 0; i < 6; i++) {
    const p = productCore(ctx, ctx.productPerm.rankToIndex(bucketedRank(r, P, ctx.productZipf, Math.floor(P / 500))) + 1);
    if (p.createdTs <= ts) return p;
  }
  // Fall back to the launch catalogue, which predates the history window.
  for (let i = 0; i < 6; i++) {
    const range = sellerRange(ctx, r.int(1, ctx.launchSellers));
    if (range.size < 1) continue;
    const p = productCore(ctx, range.first + r.int(0, Math.ceil(range.size / 2) - 1));
    if (p.createdTs <= ts) return p;
  }
  return productCore(ctx, 1); // seller 1 is a launch seller and always owns product 1
}

function pickSameSellerProduct(ctx, r, sellerId, ts) {
  const range = sellerRange(ctx, sellerId);
  if (range.size < 2) return null;
  for (let i = 0; i < 3; i++) {
    const p = productCore(ctx, range.first + r.int(0, range.size - 1));
    if (p.createdTs <= ts) return p;
  }
  return null;
}

function priceAt(ctx, r, p, ts) {
  const drift = 1 - (0.05 * (ctx.endTs - ts)) / YEAR;
  const u = r.next();
  const factor = u < 0.85 ? 1 : u < 0.95 ? r.between(0.85, 0.97) : r.between(1.01, 1.08);
  return Math.max(100, Math.round(p.listCents * drift * factor));
}

function distanceFactor(from, to) {
  let f;
  if (from.city === to.city && from.state === to.state) f = 0.6;
  else if (from.state === to.state) f = 1.0;
  else if (from.region === to.region) f = 1.35;
  else f = 1.9;
  if (to.region === 'North') f += 0.4;
  return f;
}

function pickCarrier(ctx, r, sameCity, dest) {
  if (sameCity && r.chance(0.35)) return ctx.carriers[4];
  const w = [0.5, 0.28, dest.region === 'North' || dest.region === 'Northeast' ? 0.3 : 0.03, dest.region === 'South' ? 0.3 : 0.04];
  return ctx.carriers[r.weighted(cumulative(w))];
}

const RATING_CDF = {
  base: cumulative([0.11, 0.03, 0.08, 0.19, 0.59]),
  late: cumulative([0.38, 0.14, 0.16, 0.14, 0.18]),
  returned: cumulative([0.45, 0.2, 0.15, 0.1, 0.1]),
};
const RETURN_REASONS = ['defective', 'damaged_in_transit', 'wrong_item', 'not_as_described', 'changed_mind'];
const RETURN_REASON_CDF = cumulative([0.28, 0.14, 0.1, 0.2, 0.28]);
const INSTALLMENTS = [1, 2, 3, 4, 5, 6, 8, 10];
const INSTALLMENT_CDF = cumulative([45, 12, 12, 8, 6, 5, 4, 8]);

// ---------------------------------------------------------------- orders

// Builds one order and all its dependent rows. When `out` is null, only the
// summary is returned (used to derive converted shopping carts).
export function buildOrder(ctx, orderId, out) {
  const r = new Rng(ctx.seed, STREAM.ORDER, orderId);
  const { endTs, cfg } = ctx;

  // The purchase date follows the seasonal curve; if the chosen customer had not
  // signed up yet, another customer is chosen rather than moving the date (moving
  // it would pile orders up at the end of the window).
  let ts = sampleTs(ctx, r);
  let customerId = pickCustomerId(ctx, r, orderId);
  let cust = customerCore(ctx, customerId);
  for (let i = 0; i < 16 && cust.createdTs > ts; i++) {
    customerId = pickCustomerId(ctx, r);
    cust = customerCore(ctx, customerId);
  }
  if (ts < cust.createdTs) ts = Math.min(endTs - HOUR, cust.createdTs + r.int(HOUR, 30 * DAY));
  const addrSeq = cust.nAddr === 1 || r.chance(0.85) ? 1 : r.int(2, cust.nAddr);
  const dest = ctx.locations[cust.addrLocs[addrSeq - 1]];

  // Lines: mostly from the same seller as the first item, like real carts.
  const nTarget = Math.min(8, 1 + r.poisson(cfg.avgItemsPerOrder - 1));
  const lines = [];
  for (let i = 0; i < nTarget; i++) {
    let p = i > 0 && r.chance(0.75) ? pickSameSellerProduct(ctx, r, lines[0].product.sellerId, ts) : null;
    if (!p) p = pickProduct(ctx, r, ts);
    const existing = lines.find((l) => l.product.id === p.id);
    if (existing) {
      existing.qty += 1;
      continue;
    }
    const qty = r.chance(0.9) ? 1 : r.chance(0.75) ? 2 : r.int(3, 4);
    lines.push({ seq: lines.length + 1, product: p, qty, unitCents: priceAt(ctx, r, p, ts), freightCents: 0, shipment: null });
  }
  let subtotal = 0;
  for (const l of lines) {
    subtotal += l.qty * l.unitCents;
    const from = ctx.locations[l.product.sellerLocIdx];
    const kg = (l.product.weightG * l.qty) / 1000;
    l.freightCents = Math.round((790 * (1 + 0.3 * (l.qty - 1)) + 260 * kg) * distanceFactor(from, dest) * r.between(0.9, 1.15));
  }
  if (subtotal >= 25000 && r.chance(0.2)) for (const l of lines) l.freightCents = 0;
  const shippingTotal = lines.reduce((s, l) => s + l.freightCents, 0);

  let discount = 0;
  let promotionId = null;
  const live = ctx.promotionsByDay[Math.floor((ts - ctx.startTs) / DAY)];
  if (live.length > 0 && r.chance(cfg.promotionRate)) {
    const promo = promotionCore(ctx, r.pick(live));
    if (ts >= promo.startsAt && ts <= promo.endsAt && subtotal >= promo.minOrder) {
      discount = promo.percent ? Math.min(Math.floor((subtotal * promo.value) / 100), promo.maxDiscount) : Math.min(promo.value, Math.floor(subtotal / 2));
      if (discount > 0) promotionId = promo.id;
      else discount = 0;
    }
  }
  const total = subtotal + shippingTotal - discount;

  // Payment plan.
  const method = METHODS[r.weighted(ctx.methodCdf)];
  const pays = [];
  if (method !== 'voucher' && total > 3000 && r.chance(cfg.splitPaymentRate)) {
    const v = Math.min(total - 1000, r.int(10, 100) * 100);
    pays.push({ seq: 1, method: 'voucher', amount: v, installments: 1 });
    pays.push({ seq: 2, method, amount: total - v, installments: 1 });
  } else {
    pays.push({ seq: 1, method, amount: total, installments: 1 });
  }
  const main = pays[pays.length - 1];
  if (main.method === 'credit_card' && main.amount >= 5000) main.installments = INSTALLMENTS[r.weighted(INSTALLMENT_CDF)];

  // Lifecycle, computed in full and then truncated at the end of the window.
  let approvedTs = null;
  let cancelTs = null;
  let cancelStatus = null;
  let cancelReason = null;
  let declines = 0;
  if (main.method === 'boleto') {
    if (r.chance(0.08)) {
      cancelTs = ts + 3 * DAY + r.int(0, 2 * DAY);
      cancelStatus = 'canceled';
      cancelReason = 'boleto_expired';
    } else {
      approvedTs = ts + Math.round(clamp(r.lognormal(26 * HOUR, 0.5), HOUR, 5 * DAY));
    }
  } else if (main.method === 'credit_card' || main.method === 'debit_card') {
    if (r.chance(0.035)) {
      declines = 1;
      if (r.chance(0.35)) {
        declines = 2;
        cancelTs = ts + r.int(600, 7200);
        cancelStatus = 'canceled';
        cancelReason = 'card_declined';
      }
    }
    if (!cancelTs) approvedTs = ts + Math.round(clamp(r.lognormal(900, 1.0), 30, 2 * DAY)) + declines * r.int(120, 1800);
  } else {
    approvedTs = ts + r.int(20, 900);
  }
  if (approvedTs !== null) {
    if (r.chance(0.007)) {
      cancelTs = approvedTs + r.int(HOUR, 30 * HOUR);
      cancelStatus = 'canceled';
      cancelReason = 'customer_request';
    } else if (r.chance(0.005)) {
      cancelTs = approvedTs + r.int(DAY, 3 * DAY);
      cancelStatus = 'unavailable';
      cancelReason = 'out_of_stock';
    }
  }
  const approvedVisible = approvedTs !== null && approvedTs <= endTs;
  const canceledVisible = cancelTs !== null && cancelTs <= endTs;

  // Shipments: one per seller, planned only for orders that are never canceled.
  const shipments = [];
  if (approvedTs !== null && cancelTs === null) {
    const bySeller = new Map();
    for (const l of lines) {
      if (!bySeller.has(l.product.sellerId)) bySeller.set(l.product.sellerId, []);
      bySeller.get(l.product.sellerId).push(l);
    }
    for (const [sellerId, group] of bySeller) {
      const sc = sellerCore(ctx, sellerId);
      const from = ctx.locations[sc.locIdx];
      const sameCity = from.city === dest.city && from.state === dest.state;
      const df = distanceFactor(from, dest);
      const carrier = pickCarrier(ctx, r, sameCity, dest);
      const labelTs = approvedTs + r.int(1800, 12 * HOUR);
      const handling = Math.round(clamp(r.lognormal(1.6 * DAY * sc.handlingFactor, 0.5), 4 * HOUR, 15 * DAY));
      const shippedTs = Math.max(labelTs + 1800, approvedTs + handling);
      const transitMedian = carrier.median * DAY * (carrier.level === 'same_day' ? 1 : Math.pow(df, 0.8));
      let transit = clamp(r.lognormal(transitMedian, 0.4), 0.4 * DAY, 60 * DAY);
      if (r.chance(0.07)) transit *= r.between(1.6, 3);
      transit = Math.round(transit);
      const failed = r.chance(0.025);
      const firstAttemptTs = shippedTs + transit;
      const deliveredTs = failed ? firstAttemptTs + r.int(1, 3) * DAY + r.int(0, 8 * HOUR) : firstAttemptTs;
      const estDays = Math.ceil(4 + 1.6 * carrier.median * Math.pow(df, 0.8) + 1.5 * sc.handlingFactor);
      const estimateTs = dayStart(ts) + estDays * DAY + DAY - 1;
      const sh = {
        seq: shipments.length + 1, sellerId, warehouseId: sc.warehouseId, whLocIdx: ctx.warehouses[sc.warehouseId - 1].locIdx,
        carrier, labelTs, shippedTs, firstAttemptTs, deliveredTs, failed, estimateTs, df, lines: group,
      };
      for (const l of group) l.shipment = sh;
      shipments.push(sh);
    }
  }
  const visibleShipments = approvedVisible ? shipments.filter((s) => s.labelTs <= endTs) : [];

  let status;
  let deliveredAt = null;
  if (canceledVisible) status = cancelStatus;
  else if (!approvedVisible) status = 'created';
  else if (shipments.length === 0) status = 'approved';
  else if (visibleShipments.length === shipments.length && shipments.every((s) => s.deliveredTs <= endTs)) {
    status = 'delivered';
    deliveredAt = Math.max(...shipments.map((s) => s.deliveredTs));
  } else if (visibleShipments.some((s) => s.shippedTs <= endTs)) status = 'shipped';
  else status = 'approved';
  const estimateTs = approvedVisible && shipments.length ? Math.max(...shipments.map((s) => s.estimateTs)) : null;
  const late = deliveredAt !== null && deliveredAt > estimateTs;

  const summary = { orderId, customerId, purchasedTs: ts, lines, status };
  if (!out) return summary;

  // Returns (delivered orders only) and the refunds they cause.
  const refunds = [];
  let returnedSeqs = null;
  if (status === 'delivered' && r.chance(cfg.returnRate * (late ? 2 : 1))) {
    const requestTs = deliveredAt + Math.round(clamp(r.lognormal(5 * DAY, 0.7), HOUR, 29 * DAY));
    if (requestTs <= endTs) {
      const reason = late && r.chance(0.4) ? 'late_delivery' : RETURN_REASONS[r.weighted(RETURN_REASON_CDF)];
      const rejected = r.chance(0.06);
      const items = [];
      for (const l of lines) if (r.chance(0.7)) items.push(l);
      if (!items.length) items.push(lines[0]);
      returnedSeqs = new Set();
      let refundCents = 0;
      const receivedTs = rejected ? null : requestTs + r.int(3, 10) * DAY + r.int(0, DAY);
      const refundedTs = receivedTs === null ? null : receivedTs + r.int(1, 4) * DAY;
      const receivedVisible = receivedTs !== null && receivedTs <= endTs;
      const refundedVisible = refundedTs !== null && refundedTs <= endTs;
      for (const l of items) {
        const qty = r.int(1, l.qty);
        const damaged = reason === 'defective' || reason === 'damaged_in_transit' || r.chance(0.1);
        refundCents += qty * l.unitCents;
        returnedSeqs.add(l.seq);
        out.return_items.push([orderId, 1, l.seq, qty, damaged ? 'damaged' : 'resellable']);
        if (!damaged && !rejected && receivedVisible) {
          out.inventory_movements.push([l.product.id, l.product.warehouseId, 'return', qty, orderId, fmtTs(receivedTs), 'Customer return restocked']);
        }
      }
      const rstatus = rejected ? 'rejected' : refundedVisible ? 'refunded' : receivedVisible ? 'received' : 'requested';
      out.order_returns.push([
        orderId, 1, rstatus, reason, fmtTs(requestTs), receivedVisible ? fmtTs(receivedTs) : null,
        refundedVisible ? fmtTs(refundedTs) : null, money(rejected ? 0 : refundCents),
      ]);
      if (refundedVisible) refunds.push({ amount: refundCents, ts: refundedTs });
    }
  }
  if (canceledVisible && approvedTs !== null) {
    const refundTs = cancelTs + r.int(HOUR, 2 * DAY);
    if (refundTs <= endTs) refunds.push({ amount: total, ts: refundTs });
  }

  out.orders.push([
    orderId, `O${base36(orderId, 13)}`, customerId, addrSeq, status, 'BRL', money(subtotal), money(shippingTotal), money(discount),
    money(total), fmtTs(ts), approvedVisible ? fmtTs(approvedTs) : null, estimateTs === null ? null : fmtTs(estimateTs),
    fmtTs(deliveredAt), canceledVisible ? fmtTs(cancelTs) : null,
  ]);

  for (const sh of visibleShipments) {
    const shipped = sh.shippedTs <= endTs;
    const delivered = sh.deliveredTs <= endTs;
    const weight = sh.lines.reduce((s, l) => s + l.product.weightG * l.qty, 0);
    const cost = sh.lines.reduce((s, l) => s + l.freightCents, 0);
    out.shipments.push([
      orderId, sh.seq, sh.sellerId, sh.warehouseId, sh.carrier.id, `SY${base36(orderId, 9)}${sh.seq}BR`,
      delivered ? 'delivered' : shipped ? 'in_transit' : 'label_created', money(cost), weight, dest.locationId,
      fmtTs(sh.labelTs), shipped ? fmtTs(sh.shippedTs) : null, fmtTs(sh.estimateTs), delivered ? fmtTs(sh.deliveredTs) : null,
    ]);
    trackingEvents(ctx, r, orderId, sh, dest, out);
    if (shipped) {
      for (const l of sh.lines) {
        out.inventory_movements.push([l.product.id, l.product.warehouseId, 'sale', -l.qty, orderId, fmtTs(sh.shippedTs), null]);
      }
    }
  }
  for (const l of lines) {
    const shipmentSeq = l.shipment && l.shipment.labelTs <= endTs && approvedVisible ? l.shipment.seq : null;
    out.order_items.push([orderId, l.seq, l.product.id, shipmentSeq, l.qty, money(l.unitCents), money(l.freightCents)]);
  }

  // Payments and their transaction trail.
  const refundLeft = refunds.map((x) => ({ ...x }));
  for (let i = pays.length - 1; i >= 0; i--) {
    const p = pays[i];
    p.refunds = [];
    for (const rf of refundLeft) {
      const take = Math.min(rf.amount, p.amount - p.refunds.reduce((s, x) => s + x.amount, 0));
      if (take > 0) {
        p.refunds.push({ amount: take, ts: rf.ts });
        rf.amount -= take;
      }
    }
  }
  for (const p of pays) {
    const txns = [];
    let pstatus;
    let capturedTs = null;
    const isCard = p.method === 'credit_card' || p.method === 'debit_card';
    if (p === main && isCard) for (let d = 0; d < declines; d++) txns.push(['authorization', 'declined', p.amount, ts + d * 60]);
    if (p === main && p.method === 'boleto') txns.push(['authorization', 'success', p.amount, ts]);
    if (approvedVisible) {
      if (p === main && isCard) txns.push(['authorization', 'success', p.amount, approvedTs - 10]);
      txns.push(['capture', 'success', p.amount, approvedTs]);
      capturedTs = approvedTs;
      const refunded = p.refunds.reduce((s, x) => s + x.amount, 0);
      for (const rf of p.refunds) txns.push(['refund', 'success', rf.amount, rf.ts]);
      pstatus = refunded === 0 ? 'captured' : refunded >= p.amount ? 'refunded' : 'partially_refunded';
    } else if (canceledVisible) {
      pstatus = cancelReason === 'card_declined' && p === main ? 'failed' : 'voided';
      if (p.method === 'boleto' || p.method === 'voucher') txns.push(['void', 'success', p.amount, cancelTs]);
    } else {
      pstatus = 'pending';
    }
    out.payments.push([orderId, p.seq, p.method, p.installments, money(p.amount), pstatus, fmtTs(ts), fmtTs(capturedTs)]);
    txns.sort((a, b) => a[3] - b[3]);
    txns.filter((t) => t[3] <= endTs).forEach(([type, tstatus, amount, at], k) => {
      out.payment_transactions.push([orderId, p.seq, k + 1, type, tstatus, money(amount), `PX-${base36(orderId, 10)}-${p.seq}-${k + 1}`, fmtTs(at)]);
    });
  }

  if (promotionId !== null) out.promotion_redemptions.push([orderId, promotionId, money(discount), fmtTs(ts)]);

  if (status === 'delivered') {
    for (const l of lines) {
      if (!r.chance(cfg.reviewRate)) continue;
      const cdf = returnedSeqs?.has(l.seq) ? RATING_CDF.returned : late ? RATING_CDF.late : RATING_CDF.base;
      const rating = r.weighted(cdf) + 1;
      const createdTs = deliveredAt + Math.round(clamp(r.lognormal(1.5 * DAY, 0.8), HOUR, 60 * DAY));
      if (createdTs > endTs) continue;
      const answeredTs = r.chance(0.3) ? createdTs + r.int(2 * HOUR, 5 * DAY) : null;
      out.product_reviews.push([
        orderId, l.seq, rating, r.pick(REF.REVIEW_TITLES[rating]), r.chance(0.45) ? r.pick(REF.REVIEW_COMMENTS[rating]) : null,
        fmtTs(createdTs), answeredTs !== null && answeredTs <= endTs ? fmtTs(answeredTs) : null,
      ]);
    }
  }
  return summary;
}

function trackingEvents(ctx, r, orderId, sh, dest, out) {
  const events = [];
  const whLoc = ctx.locations[sh.whLocIdx];
  const destState = ctx.locIndexesByState.get(dest.state);
  events.push(['label_created', sh.labelTs, whLoc.locationId, 'Shipping label created']);
  events.push(['picked_up', sh.shippedTs, whLoc.locationId, `Picked up by ${sh.carrier.name.replace(' (fictional)', '')}`]);
  const deliveryAttempts = [];
  if (sh.failed) {
    const firstOfd = sh.firstAttemptTs - r.int(2 * HOUR, 6 * HOUR);
    deliveryAttempts.push(['out_for_delivery', firstOfd, dest.locationId, 'Out for delivery']);
    deliveryAttempts.push(['delivery_failed', sh.firstAttemptTs, dest.locationId, 'Delivery attempt failed: recipient absent']);
    deliveryAttempts.push(['out_for_delivery', sh.deliveredTs - r.int(HOUR, 5 * HOUR), dest.locationId, 'Out for delivery (second attempt)']);
  } else {
    const window = sh.deliveredTs - sh.shippedTs;
    deliveryAttempts.push(['out_for_delivery', sh.deliveredTs - r.int(HOUR, Math.max(HOUR, Math.min(6 * HOUR, Math.floor(window * 0.3)))), dest.locationId, 'Out for delivery']);
  }
  const transitEnd = deliveryAttempts[0][1];
  const nTransit = sh.df > 1.2 ? r.int(1, 3) : r.int(0, 1);
  const fracs = [];
  for (let i = 0; i < nTransit; i++) fracs.push(r.between(0.1, 0.9));
  fracs.sort((a, b) => a - b);
  fracs.forEach((f, i) => {
    const at = Math.round(sh.shippedTs + (transitEnd - sh.shippedTs) * f);
    const loc = i === fracs.length - 1 ? ctx.locations[r.pick(destState)] : whLoc;
    events.push(['in_transit', at, loc.locationId, `In transit at ${loc.city}/${loc.state}`]);
  });
  events.push(...deliveryAttempts);
  events.push(['delivered', sh.deliveredTs, dest.locationId, 'Delivered to recipient']);
  let seq = 0;
  for (const [type, at, loc, desc] of events) {
    if (at > ctx.endTs) break;
    out.shipment_tracking_events.push([orderId, sh.seq, ++seq, type, fmtTs(at), loc, desc]);
  }
}

// ---------------------------------------------------------------- carts

export function buildCart(ctx, cartId, out) {
  const r = new Rng(ctx.seed, STREAM.CART, cartId);
  const { endTs } = ctx;
  if (ctx.cartOrderPerm && cartId <= ctx.cfg.orders && r.chance(0.2)) {
    const orderId = ctx.cartOrderPerm.rankToIndex(cartId - 1) + 1;
    const o = buildOrder(ctx, orderId, null);
    const cust = customerCore(ctx, o.customerId);
    const createdTs = Math.max(cust.createdTs, o.purchasedTs - r.int(600, 3 * DAY));
    out.shopping_carts.push([cartId, o.customerId, 'converted', orderId, fmtTs(createdTs), fmtTs(o.purchasedTs)]);
    for (const l of o.lines) {
      const added = Math.min(o.purchasedTs, Math.max(createdTs, l.product.createdTs) + r.int(0, 1800));
      out.shopping_cart_items.push([cartId, l.product.id, l.qty, money(l.unitCents), fmtTs(added)]);
    }
    return;
  }
  const customerId = pickCustomerId(ctx, r);
  const cust = customerCore(ctx, customerId);
  let createdTs = sampleTs(ctx, r);
  if (createdTs < cust.createdTs) createdTs = Math.min(endTs - HOUR, cust.createdTs + r.int(HOUR, 20 * DAY));
  const n = r.int(1, 4);
  const seen = new Set();
  let updatedTs = createdTs;
  const items = [];
  for (let i = 0; i < n; i++) {
    const p = pickProduct(ctx, r, createdTs);
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const added = Math.min(endTs, createdTs + r.int(0, 2 * HOUR));
    updatedTs = Math.max(updatedTs, added);
    items.push([cartId, p.id, r.chance(0.85) ? 1 : 2, money(priceAt(ctx, r, p, createdTs)), fmtTs(added)]);
  }
  const status = updatedTs > endTs - 14 * DAY ? 'active' : 'abandoned';
  out.shopping_carts.push([cartId, customerId, status, null, fmtTs(createdTs), fmtTs(updatedTs)]);
  out.shopping_cart_items.push(...items);
}

// ---------------------------------------------------------------- stock movements

export function buildMovement(ctx, idx, out) {
  const r = new Rng(ctx.seed, STREAM.MOVEMENT, idx);
  const p = pickProduct(ctx, r, ctx.endTs);
  let ts = sampleTs(ctx, r);
  if (ts < p.createdTs) ts = Math.min(ctx.endTs, p.createdTs + r.int(DAY, 29 * DAY));
  const u = r.next();
  let type;
  let qty;
  let note;
  if (u < 0.6) {
    type = 'receipt';
    qty = r.int(10, 120);
    note = 'Supplier receipt';
  } else if (u < 0.9) {
    type = 'adjustment';
    qty = r.chance(0.5) ? r.int(1, 5) : -r.int(1, 5);
    note = 'Cycle count adjustment';
  } else {
    type = 'damage';
    qty = -r.int(1, 3);
    note = 'Damaged in warehouse';
  }
  out.inventory_movements.push([p.id, p.warehouseId, type, qty, null, fmtTs(ts), note]);
}
