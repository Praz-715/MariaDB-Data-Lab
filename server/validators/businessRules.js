// Business-rule validation. Each rule is a SELECT that returns one row (with a
// `ref` column identifying the offending record) per violation; zero rows passes.
// These checks complement the schema's foreign keys and CHECK constraints with
// rules that span rows and tables.

export const RULES = [
  // Referential integrity (defence in depth: also catches data loaded with FK checks off)
  {
    id: 'orphans', category: 'Integrity', title: 'No orphaned child records',
    description: 'Order items, payments, shipments and addresses all reference existing parents.',
    sql: `SELECT CONCAT('order_items:', i.order_id, '/', i.item_seq) AS ref FROM order_items i LEFT JOIN orders o ON o.order_id = i.order_id LEFT JOIN products p ON p.product_id = i.product_id WHERE o.order_id IS NULL OR p.product_id IS NULL
          UNION ALL SELECT CONCAT('payments:', y.order_id) FROM payments y LEFT JOIN orders o ON o.order_id = y.order_id WHERE o.order_id IS NULL
          UNION ALL SELECT CONCAT('orders:', o.order_id) FROM orders o LEFT JOIN customers c ON c.customer_id = o.customer_id WHERE c.customer_id IS NULL
          UNION ALL SELECT CONCAT('products:', p.product_id) FROM products p LEFT JOIN sellers s ON s.seller_id = p.seller_id LEFT JOIN product_categories c ON c.category_id = p.category_id WHERE s.seller_id IS NULL OR c.category_id IS NULL`,
  },
  {
    id: 'orders_have_items', category: 'Integrity', title: 'Every order has at least one item',
    description: 'An order without lines cannot exist in the business process.',
    sql: 'SELECT o.order_id AS ref FROM orders o WHERE NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.order_id)',
  },
  {
    id: 'products_in_leaf_categories', category: 'Catalogue', title: 'Products belong to leaf categories',
    description: 'Products are assigned to leaf (depth > 0) categories, never to top-level groups.',
    sql: 'SELECT p.product_id AS ref FROM products p JOIN product_categories c ON c.category_id = p.category_id WHERE c.depth = 0',
  },
  {
    id: 'seller_before_product', category: 'Catalogue', title: 'Sellers exist before their products',
    description: 'A product listing cannot predate the seller account that lists it.',
    sql: 'SELECT p.product_id AS ref FROM products p JOIN sellers s ON s.seller_id = p.seller_id WHERE s.created_at > p.created_at',
  },
  {
    id: 'product_before_purchase', category: 'Catalogue', title: 'Products were listed before being bought',
    description: 'Order items only reference products created before the purchase.',
    sql: 'SELECT CONCAT(i.order_id, \'/\', i.item_seq) AS ref FROM order_items i JOIN orders o ON o.order_id = i.order_id JOIN products p ON p.product_id = i.product_id WHERE p.created_at > o.purchased_at',
  },
  {
    id: 'customer_before_purchase', category: 'Lifecycle', title: 'Customers registered before purchasing',
    description: 'No order predates its customer account.',
    sql: 'SELECT o.order_id AS ref FROM orders o JOIN customers c ON c.customer_id = o.customer_id WHERE c.created_at > o.purchased_at',
  },
  // Reconciliation
  {
    id: 'order_subtotal', category: 'Reconciliation', title: 'Order subtotal and shipping match the items',
    description: 'items_subtotal = SUM(quantity * unit_price) and shipping_total = SUM(freight_amount).',
    sql: `SELECT o.order_id AS ref FROM orders o
            JOIN (SELECT order_id, SUM(quantity * unit_price) AS s, SUM(freight_amount) AS f FROM order_items GROUP BY order_id) i ON i.order_id = o.order_id
           WHERE o.items_subtotal <> i.s OR o.shipping_total <> i.f`,
  },
  {
    id: 'payment_total', category: 'Reconciliation', title: 'Payments reconcile with order totals',
    description: 'SUM(payments.amount) = orders.total_amount (subtotal + shipping - discount) for every order.',
    // Grouped in primary-key order of both tables: no temporary table on large datasets.
    sql: `SELECT o.order_id AS ref FROM orders o FORCE INDEX (PRIMARY) LEFT JOIN payments p ON p.order_id = o.order_id
           GROUP BY o.order_id HAVING SUM(p.amount) IS NULL OR SUM(p.amount) <> MAX(o.total_amount)`,
  },
  {
    id: 'payment_status', category: 'Reconciliation', title: 'Payment status matches order approval',
    description: 'Approved orders have captured (or refunded) payments; unapproved orders never do.',
    sql: `SELECT CONCAT(p.order_id, '/', p.payment_seq) AS ref FROM payments p JOIN orders o ON o.order_id = p.order_id
           WHERE (o.approved_at IS NOT NULL AND p.status NOT IN ('captured', 'refunded', 'partially_refunded'))
              OR (o.approved_at IS NULL AND p.status IN ('captured', 'refunded', 'partially_refunded'))`,
  },
  {
    id: 'refund_not_exceeding_capture', category: 'Reconciliation', title: 'Refunds never exceed captured amounts',
    description: 'Per payment, successful refunds total no more than successful captures.',
    sql: `SELECT CONCAT(order_id, '/', payment_seq) AS ref FROM payment_transactions GROUP BY order_id, payment_seq
          HAVING SUM(IF(txn_type = 'refund' AND txn_status = 'success', amount, 0)) > SUM(IF(txn_type = 'capture' AND txn_status = 'success', amount, 0))`,
  },
  {
    id: 'shipment_cost', category: 'Reconciliation', title: 'Shipment cost equals freight of its items',
    description: 'shipments.shipping_cost = SUM(order_items.freight_amount) of the items in that shipment.',
    sql: `SELECT CONCAT(s.order_id, '/', s.shipment_seq) AS ref FROM shipments s FORCE INDEX (PRIMARY)
            LEFT JOIN order_items i ON i.order_id = s.order_id AND i.shipment_seq = s.shipment_seq
           GROUP BY s.order_id, s.shipment_seq HAVING SUM(i.freight_amount) IS NULL OR SUM(i.freight_amount) <> MAX(s.shipping_cost)`,
  },
  {
    id: 'promotion_redemption', category: 'Reconciliation', title: 'Discounts come from live promotions',
    description: 'Every discount has a redemption of a promotion active at purchase time, with the same amount.',
    sql: `SELECT r.order_id AS ref FROM promotion_redemptions r JOIN promotions p ON p.promotion_id = r.promotion_id JOIN orders o ON o.order_id = r.order_id
           WHERE o.purchased_at NOT BETWEEN p.starts_at AND p.ends_at OR r.discount_amount <> o.discount_total OR o.items_subtotal < p.min_order_amount
          UNION ALL
          SELECT o.order_id FROM orders o WHERE o.discount_total > 0 AND NOT EXISTS (SELECT 1 FROM promotion_redemptions r WHERE r.order_id = o.order_id)`,
  },
  // Lifecycle
  {
    id: 'item_seller_shipment', category: 'Lifecycle', title: 'Items ship with their seller',
    description: "An item's shipment belongs to the seller who lists the product, from that seller's home warehouse.",
    sql: `SELECT CONCAT(i.order_id, '/', i.item_seq) AS ref FROM order_items i
            JOIN shipments s ON s.order_id = i.order_id AND s.shipment_seq = i.shipment_seq
            JOIN products p ON p.product_id = i.product_id
            JOIN sellers se ON se.seller_id = s.seller_id
           WHERE p.seller_id <> s.seller_id OR se.home_warehouse_id <> s.warehouse_id`,
  },
  {
    id: 'shipment_after_approval', category: 'Lifecycle', title: 'Shipments follow payment approval',
    description: 'Labels are created only after approval; delivery never precedes purchase.',
    // Scanned in primary-key order so the orders lookups are sequential.
    sql: `SELECT CONCAT(s.order_id, '/', s.shipment_seq) AS ref FROM shipments s FORCE INDEX (PRIMARY) JOIN orders o ON o.order_id = s.order_id
           WHERE o.approved_at IS NULL OR s.created_at < o.approved_at OR (s.delivered_at IS NOT NULL AND s.delivered_at < o.purchased_at)`,
  },
  {
    id: 'shipment_destination', category: 'Geography', title: "Shipments go to the order's address",
    description: 'Shipment destination equals the location of the selected customer shipping address.',
    sql: `SELECT CONCAT(s.order_id, '/', s.shipment_seq) AS ref FROM shipments s JOIN orders o ON o.order_id = s.order_id
            JOIN customer_addresses a ON a.customer_id = o.customer_id AND a.address_seq = o.shipping_address_seq
           WHERE a.location_id <> s.destination_location_id`,
  },
  {
    id: 'delivered_consistency', category: 'Lifecycle', title: 'Delivered orders are fully delivered',
    description: 'status = delivered implies every shipment is delivered and delivered_at = last shipment delivery.',
    sql: `SELECT o.order_id AS ref FROM orders o
            LEFT JOIN (SELECT order_id, MAX(delivered_at) AS d, SUM(status <> 'delivered') AS open_shipments FROM shipments GROUP BY order_id) s ON s.order_id = o.order_id
           WHERE o.status = 'delivered' AND (s.order_id IS NULL OR s.open_shipments > 0 OR s.d <> o.delivered_at)`,
  },
  {
    id: 'shipped_consistency', category: 'Lifecycle', title: 'Shipped orders have a shipment in transit',
    description: 'status = shipped implies at least one shipment has been picked up.',
    sql: `SELECT o.order_id AS ref FROM orders o WHERE o.status = 'shipped'
             AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.order_id AND s.shipped_at IS NOT NULL)`,
  },
  {
    id: 'canceled_not_shipped', category: 'Lifecycle', title: 'Canceled orders were never shipped',
    description: 'Canceled and unavailable orders have no shipments.',
    sql: `SELECT o.order_id AS ref FROM orders o WHERE o.status IN ('canceled', 'unavailable')
             AND EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.order_id)`,
  },
  {
    id: 'tracking_sequence', category: 'Lifecycle', title: 'Tracking events are chronological',
    description: 'Events fall inside the shipment window and never go back in time.',
    // PRIMARY order keeps the shipment and previous-event lookups sequential; the
    // optimizer otherwise prefers the smaller event_at index (random I/O at scale).
    sql: `SELECT CONCAT(e.order_id, '/', e.shipment_seq, '/', e.event_seq) AS ref FROM shipment_tracking_events e FORCE INDEX (PRIMARY)
            JOIN shipments s ON s.order_id = e.order_id AND s.shipment_seq = e.shipment_seq
            LEFT JOIN shipment_tracking_events p ON p.order_id = e.order_id AND p.shipment_seq = e.shipment_seq AND p.event_seq = e.event_seq - 1
           WHERE e.event_at < s.created_at OR (s.delivered_at IS NOT NULL AND e.event_at > s.delivered_at)
              OR (p.event_at IS NOT NULL AND e.event_at < p.event_at)`,
  },
  {
    id: 'reviews_after_delivery', category: 'Lifecycle', title: 'Reviews follow delivery of purchased items',
    description: 'Reviews exist only for delivered orders and are written after delivery.',
    sql: `SELECT CONCAT(r.order_id, '/', r.item_seq) AS ref FROM product_reviews r JOIN orders o ON o.order_id = r.order_id
           WHERE o.status <> 'delivered' OR r.created_at < o.delivered_at`,
  },
  {
    id: 'returns_after_delivery', category: 'Returns', title: 'Returns follow delivery',
    description: 'Returns exist only for delivered orders and are requested after delivery.',
    sql: `SELECT r.order_id AS ref FROM order_returns r JOIN orders o ON o.order_id = r.order_id
           WHERE o.status <> 'delivered' OR r.requested_at < o.delivered_at`,
  },
  {
    id: 'return_quantity', category: 'Returns', title: 'Returned quantity never exceeds purchased quantity',
    description: 'Per order line, the total returned quantity is at most the purchased quantity.',
    sql: `SELECT CONCAT(ri.order_id, '/', ri.item_seq) AS ref
            FROM (SELECT order_id, item_seq, SUM(quantity) AS q FROM return_items GROUP BY order_id, item_seq) ri
            JOIN order_items i ON i.order_id = ri.order_id AND i.item_seq = ri.item_seq
           WHERE ri.q > i.quantity`,
  },
  {
    id: 'return_refund_amount', category: 'Returns', title: 'Return refunds equal returned item value',
    description: 'refund_amount = SUM(returned quantity * unit_price) for accepted returns.',
    sql: `SELECT r.order_id AS ref FROM order_returns r
            JOIN (SELECT ri.order_id, ri.return_seq, SUM(ri.quantity * i.unit_price) AS v FROM return_items ri
                    JOIN order_items i ON i.order_id = ri.order_id AND i.item_seq = ri.item_seq GROUP BY ri.order_id, ri.return_seq) x
              ON x.order_id = r.order_id AND x.return_seq = r.return_seq
           WHERE r.status <> 'rejected' AND r.refund_amount <> x.v`,
  },
  // Inventory
  {
    id: 'inventory_balance', category: 'Inventory', title: 'Stock balances equal the movement ledger',
    description: 'inventory.quantity_on_hand = SUM(inventory_movements.quantity) and is never negative.',
    sql: `SELECT CONCAT(i.product_id, '@', i.warehouse_id) AS ref FROM inventory i
            LEFT JOIN (SELECT product_id, warehouse_id, SUM(quantity) AS b FROM inventory_movements GROUP BY product_id, warehouse_id) m
                   ON m.product_id = i.product_id AND m.warehouse_id = i.warehouse_id
           WHERE COALESCE(m.b, 0) <> i.quantity_on_hand OR i.quantity_on_hand < 0`,
  },
  {
    id: 'sales_match_shipments', category: 'Inventory', title: 'Sale movements match shipped quantities',
    description: 'Each order has exactly as many units of sale movements as units in picked-up shipments.',
    sql: `SELECT COALESCE(a.order_id, b.order_id) AS ref FROM
            (SELECT i.order_id, SUM(i.quantity) AS q FROM order_items i JOIN shipments s ON s.order_id = i.order_id AND s.shipment_seq = i.shipment_seq
              WHERE s.shipped_at IS NOT NULL GROUP BY i.order_id) a
            LEFT JOIN (SELECT order_id, -SUM(quantity) AS q FROM inventory_movements WHERE movement_type = 'sale' GROUP BY order_id) b ON b.order_id = a.order_id
           WHERE b.q IS NULL OR a.q <> b.q`,
  },
  // Geography and carts
  {
    id: 'zip_consistency', category: 'Geography', title: 'Postal codes match their locations',
    description: 'The first five digits of every address zip code equal its location zip prefix.',
    // STRAIGHT_JOIN: scan the addresses once and look up the small locations table,
    // instead of reaching every address through the location index.
    sql: `SELECT CONCAT('customer:', a.customer_id, '/', a.address_seq) AS ref FROM customer_addresses a STRAIGHT_JOIN geographic_locations g ON g.location_id = a.location_id WHERE LEFT(a.zip_code, 5) <> g.zip_prefix
          UNION ALL SELECT CONCAT('seller:', a.seller_id, '/', a.address_seq) FROM seller_addresses a STRAIGHT_JOIN geographic_locations g ON g.location_id = a.location_id WHERE LEFT(a.zip_code, 5) <> g.zip_prefix`,
  },
  {
    id: 'converted_carts', category: 'Carts', title: 'Converted carts match their orders',
    description: 'A converted cart belongs to the ordering customer, predates the purchase, and holds the ordered products.',
    sql: `SELECT c.cart_id AS ref FROM shopping_carts c JOIN orders o ON o.order_id = c.converted_order_id
           WHERE o.customer_id <> c.customer_id OR c.created_at > o.purchased_at
          UNION ALL
          SELECT c.cart_id FROM shopping_carts c JOIN shopping_cart_items ci ON ci.cart_id = c.cart_id
           WHERE c.status = 'converted' AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = c.converted_order_id AND i.product_id = ci.product_id)`,
  },
];

// Descriptive statistics showing the data has realistic, non-uniform shape.
export const PROFILE_QUERIES = {
  orderStatus: 'SELECT status AS k, COUNT(*) AS n FROM orders GROUP BY status ORDER BY n DESC',
  paymentMethods: 'SELECT payment_method AS k, COUNT(*) AS n FROM payments GROUP BY payment_method ORDER BY n DESC',
  ratings: 'SELECT rating AS k, COUNT(*) AS n FROM product_reviews GROUP BY rating ORDER BY rating',
  topStates: `SELECT g.state_code AS k, COUNT(*) AS n FROM orders o JOIN customer_addresses a ON a.customer_id = o.customer_id AND a.address_seq = o.shipping_address_seq
               JOIN geographic_locations g ON g.location_id = a.location_id GROUP BY g.state_code ORDER BY n DESC LIMIT 8`,
  metrics: `SELECT
      (SELECT AVG(c) FROM (SELECT COUNT(*) AS c FROM order_items GROUP BY order_id) x) AS avgItemsPerOrder,
      (SELECT AVG(total_amount) FROM orders WHERE status NOT IN ('canceled', 'unavailable')) AS avgOrderValue,
      (SELECT SUM(n > 1) / COUNT(*) FROM (SELECT COUNT(*) AS n FROM orders GROUP BY customer_id) x) AS repeatCustomerRate,
      (SELECT AVG(delivered_at > estimated_delivery_at) FROM orders WHERE status = 'delivered') AS lateDeliveryRate,
      (SELECT AVG(TIMESTAMPDIFF(HOUR, purchased_at, delivered_at)) / 24 FROM orders WHERE status = 'delivered') AS avgDeliveryDays,
      (SELECT COUNT(*) FROM order_returns) / NULLIF((SELECT COUNT(*) FROM orders WHERE status = 'delivered'), 0) AS returnRate,
      (SELECT AVG(rating) FROM product_reviews) AS avgRating`,
};
