-- name: v_monthly_category_revenue
-- type: view
-- purpose: Monthly item revenue by leaf and top-level category, read from the pre-aggregated monthly_sales_summary (cheap at any data size).
-- depends: monthly_sales_summary, product_categories
-- example: SELECT * FROM v_monthly_category_revenue ORDER BY month_start DESC, revenue DESC LIMIT 10
CREATE OR REPLACE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW v_monthly_category_revenue AS
SELECT m.month_start, m.category_id, c.category_name, pc.category_name AS category_group,
       m.orders_count, m.items_sold, m.revenue
  FROM monthly_sales_summary m
  JOIN product_categories c ON c.category_id = m.category_id
  LEFT JOIN product_categories pc ON pc.category_id = c.parent_category_id
