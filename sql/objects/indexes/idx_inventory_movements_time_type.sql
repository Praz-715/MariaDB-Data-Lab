-- name: idx_inventory_movements_time_type
-- type: index
-- table: inventory_movements
-- purpose: Covering index for the monthly inbound/outbound stock chart. Without it the date-range scan on idx_inventory_movements_moved does one clustered-index lookup per movement to read type and quantity.
-- explain: SELECT DATE_FORMAT(moved_at, '%Y-%m-01') AS m, movement_type, SUM(quantity) FROM inventory_movements WHERE moved_at >= '2025-01-01' AND moved_at < '2026-01-01' GROUP BY m, movement_type
CREATE INDEX IF NOT EXISTS idx_inventory_movements_time_type ON inventory_movements (moved_at, movement_type, quantity) ALGORITHM=INPLACE LOCK=NONE
