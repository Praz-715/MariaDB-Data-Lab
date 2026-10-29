// Generator calibration from staged Olist data. The profile captures the shape
// of the real dataset (category mix and prices, payment mix, customer and seller
// geography, basket size, review coverage) so the synthetic generator can scale
// far beyond the original size with the same distributions.
import { query } from '../db.js';
import { HttpError } from '../http.js';
import { STATES } from '../generators/reference-data.js';

const METHODS = ['credit_card', 'boleto', 'pix', 'voucher', 'debit_card'];

export async function computeCalibration() {
  const [counts] = await query(
    `SELECT (SELECT COUNT(DISTINCT order_id) FROM stg_olist_orders) AS orders,
            (SELECT COUNT(*) FROM stg_olist_order_items) AS items,
            (SELECT COUNT(DISTINCT customer_unique_id) FROM stg_olist_customers) AS customers,
            (SELECT COUNT(DISTINCT seller_id) FROM stg_olist_sellers) AS sellers,
            (SELECT COUNT(DISTINCT product_id) FROM stg_olist_products) AS products,
            (SELECT COUNT(DISTINCT order_id) FROM stg_olist_reviews) AS reviewed_orders,
            (SELECT COUNT(*) FROM stg_olist_orders WHERE status = 'delivered') AS delivered,
            (SELECT MIN(purchased_at) FROM stg_olist_orders) AS first_purchase,
            (SELECT MAX(purchased_at) FROM stg_olist_orders) AS last_purchase`,
  );
  const orders = Number(counts.orders);
  if (!orders) throw new HttpError(409, 'No staged Olist orders. Import the CSV files first.');
  const items = Number(counts.items);

  const categories = (
    await query(
      `SELECT DISTINCT cat, COUNT(*) OVER (PARTITION BY cat) AS n, MEDIAN(price) OVER (PARTITION BY cat) AS med
         FROM (SELECT COALESCE((SELECT MIN(t.category_name_english) FROM stg_olist_category_translation t WHERE t.category_name = p.category_name), 'uncategorized') AS cat,
                      i.price
                 FROM stg_olist_order_items i
                 JOIN stg_olist_products p ON p.src_row = (SELECT MIN(p2.src_row) FROM stg_olist_products p2 WHERE p2.product_id = i.product_id)) x`,
    )
  )
    .map((r) => ({ code: String(r.cat).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 80), weight: Number(r.n) / items, medianPrice: Math.round(Number(r.med) * 100) / 100 }))
    .sort((a, b) => b.weight - a.weight);

  const paymentMix = Object.fromEntries(METHODS.map((m) => [m, 0]));
  const pays = await query("SELECT payment_type AS k, COUNT(*) AS n FROM stg_olist_payments WHERE payment_type <> 'not_defined' GROUP BY payment_type");
  const payTotal = pays.reduce((s, p) => s + Number(p.n), 0) || 1;
  for (const p of pays) if (p.k in paymentMix) paymentMix[p.k] = Number(p.n) / payTotal;

  const share = (rows) => {
    const total = rows.reduce((s, r) => s + Number(r.n), 0) || 1;
    return Object.fromEntries(rows.filter((r) => STATES[r.k]).map((r) => [r.k, Number(r.n) / total]));
  };
  const customerStates = share(await query('SELECT c.state AS k, COUNT(*) AS n FROM stg_olist_orders o JOIN stg_olist_customers c ON c.customer_id = o.customer_id GROUP BY c.state'));
  const sellerStates = share(await query('SELECT state AS k, COUNT(DISTINCT seller_id) AS n FROM stg_olist_sellers GROUP BY state'));

  return {
    source: 'olist-staging',
    computedAt: new Date().toISOString(),
    basis: {
      orders, items, customers: Number(counts.customers), sellers: Number(counts.sellers), products: Number(counts.products),
      firstPurchase: counts.first_purchase, lastPurchase: counts.last_purchase,
    },
    avgItemsPerOrder: Math.round((items / orders) * 1000) / 1000,
    reviewRate: Math.min(1, Math.round((Number(counts.reviewed_orders) / Math.max(1, items)) * 1000) / 1000),
    categories,
    paymentMix,
    customerStates,
    sellerStates,
  };
}
