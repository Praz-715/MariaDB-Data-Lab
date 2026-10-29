-- name: idx_customers_name
-- type: index
-- table: customers
-- purpose: Customer lookup by surname prefix (Table Explorer "starts with" filter and support-desk style search) without a full table scan.
-- explain: SELECT customer_id, first_name, last_name, email FROM customers WHERE last_name LIKE 'Silva%' ORDER BY last_name, first_name LIMIT 50
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (last_name, first_name) ALGORITHM=INPLACE LOCK=NONE
