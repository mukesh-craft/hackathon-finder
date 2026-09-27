-- Store the original source payload separately from the normalized snapshot.
--
-- `raw` holds the normalized values this source reported, keyed by database
-- column name, because cross-source conflict reconciliation compares those.
-- `source_payload` keeps the provider's original JSON/HTML-derived object for
-- debugging when a source changes shape.
ALTER TABLE hackathon_sources ADD COLUMN IF NOT EXISTS source_payload jsonb;
