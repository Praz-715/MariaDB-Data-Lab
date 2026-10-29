// Writes a SYNTHETIC dataset in the exact file layout of the Olist public dataset,
// for tests and for trying the import flow without the real data. It contains
// no Olist data. It deliberately reproduces quirks of the real files: quoted
// values, a UTF-8 BOM, review comments with commas, quotes and line breaks,
// repeat customers, products sold by several sellers, missing categories and
// weights, untranslated categories, zip prefixes absent from geolocation,
// coordinates outside Brazil, inconsistent timestamps, payments that do not add
// up, zero-value vouchers, duplicate reviews, orders without items or payments,
// and a few malformed rows that must be rejected.
//
// Usage: node scripts/make-olist-fixture.js <output-dir> [orders=2000] [seed=7]
import fs from 'node:fs';
import path from 'node:path';
import { Rng } from '../server/generators/prng.js';
import { CITIES } from '../server/generators/reference-data.js';

const [outDir = 'datasets/raw', ordersArg = '2000', seedArg = '7'] = process.argv.slice(2);
const ORDERS = Number(ordersArg);
const r = new Rng(Number(seedArg), 999, 1);
fs.mkdirSync(outDir, { recursive: true });

const hex = () => Array.from({ length: 4 }, () => r.nextU32().toString(16).padStart(8, '0')).join('');
const plain = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const ts = (t) => new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ');
const DAY = 86400;

function csv(file, header, rows, { quoteAll = false, bom = false } = {}) {
  const q = (v) => {
    if (v === null || v === undefined) return quoteAll ? '""' : '';
    const s = String(v);
    return quoteAll || /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(q).join(','), ...rows.map((row) => (typeof row === 'string' ? row : row.map(q).join(',')))];
  fs.writeFileSync(path.join(outDir, file), (bom ? '﻿' : '') + lines.join('\n') + '\n');
}

// Categories (Portuguese -> English), one deliberately untranslated.
const CATS = [
  ['cama_mesa_banho', 'bed_bath_table', 90], ['beleza_saude', 'health_beauty', 130], ['esporte_lazer', 'sports_leisure', 110],
  ['moveis_decoracao', 'furniture_decor', 85], ['informatica_acessorios', 'computers_accessories', 120], ['utilidades_domesticas', 'housewares', 80],
  ['relogios_presentes', 'watches_gifts', 200], ['telefonia', 'telephony', 70], ['ferramentas_jardim', 'garden_tools', 100], ['automotivo', 'auto', 140],
  ['brinquedos', 'toys', 95], ['perfumaria', 'perfumery', 120], ['bebes', 'baby', 125], ['eletronicos', 'electronics', 65], ['pc_gamer', null, 900],
];
csv('product_category_name_translation.csv', ['product_category_name', 'product_category_name_english'], CATS.filter((c) => c[1]).map(([pt, en]) => [pt, en]), { bom: true });

// Geography: several prefixes per city, several points per prefix.
const zips = [];
const geo = [];
for (const [state, city, lat, lng, base, weight] of CITIES) {
  const n = Math.max(1, Math.round(weight / 15));
  for (let k = 0; k < n; k++) {
    const zip = String(base + k * 3).padStart(5, '0');
    zips.push({ zip, city: plain(city), state, weight });
    for (let p = 0; p < 3; p++) geo.push([zip, (lat + r.between(-0.05, 0.05)).toFixed(14), (lng + r.between(-0.05, 0.05)).toFixed(14), plain(city), state]);
  }
}
geo.push([zips[0].zip, '42.184003', '-8.723762', zips[0].city, zips[0].state]); // outlier outside Brazil
const missingGeo = { zip: '99990', city: 'cidade sintetica', state: 'RS', weight: 1 }; // prefix absent from geolocation
csv('olist_geolocation_dataset.csv', ['geolocation_zip_code_prefix', 'geolocation_lat', 'geolocation_lng', 'geolocation_city', 'geolocation_state'], geo);
const pickZip = () => {
  const total = zips.reduce((s, z) => s + z.weight, 0);
  let x = r.next() * total;
  for (const z of zips) if ((x -= z.weight) <= 0) return z;
  return zips[0];
};

// Sellers.
const SELLERS = Math.max(5, Math.round(ORDERS / 30));
const sellers = Array.from({ length: SELLERS }, (_, i) => ({ id: hex(), ...(i === 3 ? missingGeo : pickZip()) }));
csv('olist_sellers_dataset.csv', ['seller_id', 'seller_zip_code_prefix', 'seller_city', 'seller_state'],
  sellers.map((s) => [s.id, String(Number(s.zip)), s.city, s.state])); // zip without leading zero, like the real file

// Products.
const PRODUCTS = Math.max(10, Math.round(ORDERS / 3));
const products = Array.from({ length: PRODUCTS }, (_, i) => {
  const cat = r.pick(CATS);
  return { id: hex(), cat: i % 37 === 5 ? null : cat[0], price: Math.max(5, Math.round(r.lognormal(cat[2], 0.6) * 100) / 100), seller: r.pick(sellers) };
});
csv('olist_products_dataset.csv',
  ['product_id', 'product_category_name', 'product_name_lenght', 'product_description_lenght', 'product_photos_qty', 'product_weight_g', 'product_length_cm', 'product_height_cm', 'product_width_cm'],
  [
    ...products.map((p, i) => [p.id, p.cat, p.cat ? r.int(20, 60) : null, p.cat ? r.int(100, 3000) : null, p.cat ? r.int(1, 6) : null,
      i % 53 === 7 ? null : r.int(100, 9000), r.int(10, 80), r.int(2, 50), r.int(8, 60)]),
    [products[0].id, products[0].cat, 40, 500, 2, 700, 20, 10, 15], // duplicate product row
  ]);

// Customers, orders, items, payments, reviews.
const start = Date.UTC(2017, 0, 1) / 1000;
const end = Date.UTC(2018, 7, 31) / 1000;
const customers = [];
const orders = [];
const items = [];
const payments = [];
const reviews = [];
const people = [];
const comments = ['Produto ótimo, recomendo!', 'Chegou antes do prazo, "perfeito".', 'Veio com defeito,\nsolicitei troca', 'Bom, mas a embalagem, veio amassada'];
for (let i = 0; i < ORDERS; i++) {
  const person = people.length > 20 && r.chance(0.08) ? r.pick(people) : { unique: hex(), ...(i === 11 ? missingGeo : pickZip()) };
  if (!people.includes(person)) people.push(person);
  const customerId = hex();
  customers.push([customerId, person.unique, String(Number(person.zip)), person.city, person.state]);

  const orderId = hex();
  const P = start + Math.floor(r.next() * (end - start - 40 * DAY));
  const u = r.next();
  let status = u < 0.9 ? 'delivered' : u < 0.93 ? 'shipped' : u < 0.96 ? 'canceled' : u < 0.97 ? 'unavailable' : u < 0.98 ? 'invoiced' : u < 0.99 ? 'processing' : u < 0.995 ? 'created' : 'approved';
  let A = status === 'created' ? null : P + r.int(600, 2 * DAY);
  let C = ['shipped', 'delivered'].includes(status) ? A + r.int(DAY, 5 * DAY) : null;
  let D = status === 'delivered' ? C + r.int(2 * DAY, 20 * DAY) : null;
  const E = P + r.int(15, 30) * DAY;
  if (i % 97 === 13 && status === 'delivered') D = null; // delivered without date
  if (i % 89 === 17 && D) D = C - DAY; // delivered before carrier pickup
  if (i % 83 === 19 && status === 'delivered') A = null; // delivered without approval time
  orders.push([orderId, customerId, status, ts(P), A ? ts(A) : null, C ? ts(C) : null, D ? ts(D) : null, ts(E)]);

  const noItems = (status === 'canceled' || status === 'unavailable') && r.chance(0.5);
  let total = 0;
  if (!noItems) {
    const n = r.chance(0.85) ? 1 : r.int(2, 3);
    const seller = r.pick(sellers);
    for (let k = 1; k <= n; k++) {
      const p = i % 61 === 3 && k === 1 ? products[1] : r.pick(products);
      const s = i % 61 === 3 ? seller : p.seller; // products[1] also sold by another seller
      const price = p.price;
      const freight = Math.round(r.between(8, 45) * 100) / 100;
      total += price + freight;
      items.push([orderId, k, p.id, s.id, ts(P + 3 * DAY), price.toFixed(2), freight.toFixed(2)]);
    }
    if (i === 29) items.push([orderId, n + 1, hex(), r.pick(sellers).id, ts(P + 3 * DAY), '10.00', '5.00']); // unknown product
  }
  total = Math.round(total * 100) / 100;
  if (i !== 31) {
    if (total > 0 && r.chance(0.05)) {
      const v = Math.min(total - 1, 20);
      payments.push([orderId, 1, 'voucher', 1, v.toFixed(2)]);
      payments.push([orderId, 2, 'credit_card', r.int(1, 10), (total - v).toFixed(2)]);
    } else {
      const method = r.next() < 0.75 ? 'credit_card' : r.chance(0.8) ? 'boleto' : 'debit_card';
      const inst = method === 'credit_card' ? r.int(1, 10) : 1;
      const interest = method === 'credit_card' && inst > 6 && r.chance(0.3) ? 1.03 : 1; // paid more than the total
      payments.push([orderId, 1, method, inst, (Math.max(total, 1) * interest).toFixed(2)]);
    }
    if (i % 101 === 7) payments.push([orderId, 3, 'not_defined', 0, '0.00']);
  }
  if (status !== 'created' && r.chance(0.92)) {
    const score = status === 'delivered' && D && D > E ? r.int(1, 3) : r.weighted([0.1, 0.13, 0.21, 0.4, 1]) + 1;
    const created = E - r.int(0, 3) * DAY; // surveys go out around the estimated date, sometimes before delivery
    reviews.push([hex(), orderId, score, r.chance(0.12) ? 'Recomendo' : null, r.chance(0.4) ? r.pick(comments) : null, ts(created), ts(created + r.int(1, 4) * DAY)]);
    if (i % 71 === 2) reviews.push([hex(), orderId, 5, null, 'segunda avaliação', ts(created + DAY), ts(created + 2 * DAY)]);
  }
}

// Malformed rows that must be rejected by validation.
orders.push([hex(), customers[0][0], 'delivered', '2018-13-45 99:00:00', null, null, null, null]);
customers.push([hex(), hex(), '01001', 'sao paulo', 'XX']);
items.push([orders[0][0], 9, products[2].id, sellers[0].id, ts(start), '-5.00', '1.00']);

csv('olist_customers_dataset.csv', ['customer_id', 'customer_unique_id', 'customer_zip_code_prefix', 'customer_city', 'customer_state'], customers, { quoteAll: true });
csv('olist_orders_dataset.csv', ['order_id', 'customer_id', 'order_status', 'order_purchase_timestamp', 'order_approved_at', 'order_delivered_carrier_date', 'order_delivered_customer_date', 'order_estimated_delivery_date'], orders);
csv('olist_order_items_dataset.csv', ['order_id', 'order_item_id', 'product_id', 'seller_id', 'shipping_limit_date', 'price', 'freight_value'], items);
csv('olist_order_payments_dataset.csv', ['order_id', 'payment_sequential', 'payment_type', 'payment_installments', 'payment_value'], payments);
csv('olist_order_reviews_dataset.csv', ['review_id', 'order_id', 'review_score', 'review_comment_title', 'review_comment_message', 'review_creation_date', 'review_answer_timestamp'], reviews, { quoteAll: true });
console.log(`Synthetic Olist-format fixture written to ${outDir}: ${ORDERS} orders, ${customers.length} customers, ${SELLERS} sellers, ${PRODUCTS} products, ${items.length} items, ${reviews.length} reviews`);
