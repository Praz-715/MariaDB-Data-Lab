-- name: ev_refresh_sales_summaries
-- type: event
-- purpose: Hourly refresh of the sales summary tables for the last three days. Runs only while the server's event_scheduler is ON.
-- depends: sp_refresh_sales_summaries
CREATE OR REPLACE EVENT ev_refresh_sales_summaries
ON SCHEDULE EVERY 1 HOUR STARTS CURRENT_TIMESTAMP + INTERVAL 5 MINUTE
ON COMPLETION PRESERVE
ENABLE
COMMENT 'mariadb-data-lab: hourly sales summary refresh'
DO CALL sp_refresh_sales_summaries(CURRENT_DATE - INTERVAL 3 DAY, CURRENT_DATE)
