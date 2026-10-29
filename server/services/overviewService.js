// Overview KPIs. Counts come from MariaDB: exact COUNT(*) for small tables and
// InnoDB statistics (clearly flagged as estimates) for large ones. Revenue is read
// from daily_sales_summary, which the generator refreshes in its final phase.
import { query, getProfile } from '../db.js';
import { BUSINESS_TABLES } from './schemaService.js';

const EXACT_COUNT_LIMIT = 2_000_000;
const KPI_TABLES = ['customers', 'products', 'sellers', 'orders'];

export async function overview() {
  const { database } = getProfile();
  const stats = await query(
    `SELECT TABLE_NAME AS name, TABLE_ROWS AS estRows, DATA_LENGTH + INDEX_LENGTH AS bytes
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
    [database],
  );
  const byName = new Map(stats.map((s) => [s.name, s]));
  const counts = {};
  for (const t of KPI_TABLES) {
    const est = Number(byName.get(t)?.estRows ?? 0);
    if (est < EXACT_COUNT_LIMIT) {
      const [r] = await query(`SET STATEMENT max_statement_time = 10 FOR SELECT COUNT(*) AS n FROM \`${t}\``);
      counts[t] = { value: Number(r.n), exact: true };
    } else {
      counts[t] = { value: est, exact: false };
    }
  }
  const [sales] = await query(
    `SELECT SUM(net_revenue) AS revenue, SUM(orders_count - canceled_orders) AS validOrders,
            MIN(sales_date) AS firstDay, MAX(sales_date) AS lastDay, MAX(refreshed_at) AS refreshedAt
       FROM daily_sales_summary`,
  );
  const revenue = sales.revenue == null ? null : Number(sales.revenue);
  const validOrders = Number(sales.validOrders || 0);
  const generatedRows = BUSINESS_TABLES.reduce((s, t) => s + Number(byName.get(t)?.estRows ?? 0), 0);
  const totalBytes = stats.reduce((s, t) => s + Number(t.bytes || 0), 0);
  return {
    database,
    counts,
    revenue: {
      total: revenue,
      averageOrderValue: validOrders ? revenue / validOrders : null,
      validOrders,
      currency: 'BRL',
      source: 'daily_sales_summary',
      firstDay: sales.firstDay,
      lastDay: sales.lastDay,
      refreshedAt: sales.refreshedAt,
    },
    storage: { totalBytes, estimatedRows: generatedRows, rowsAreEstimates: true },
  };
}
