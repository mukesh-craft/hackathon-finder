-- Non-deadline field disagreements are tracked separately so that a mere title
-- variation across sources never sets the deadline_conflict flag or degrades the
-- record's data quality. Only registration_deadline disagreements do that.
ALTER TABLE hackathons ADD COLUMN IF NOT EXISTS field_conflicts jsonb;
