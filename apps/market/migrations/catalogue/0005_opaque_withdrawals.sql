ALTER TABLE versions ADD COLUMN withdrawal_id TEXT;
CREATE INDEX versions_withdrawal_id ON versions (withdrawal_id) WHERE withdrawal_id IS NOT NULL;
