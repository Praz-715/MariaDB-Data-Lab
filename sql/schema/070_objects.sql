-- Schema version 3: job type for the database object generator and partitioning
-- experiments. MODIFY to the same definition is safe to re-run.

ALTER TABLE lab_jobs MODIFY job_type ENUM('generation','validation','import','benchmark','cleanup','objects') NOT NULL;
