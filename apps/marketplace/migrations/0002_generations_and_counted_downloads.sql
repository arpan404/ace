-- An entry's generation moves with every change to its versions, in the same batch, so an entry
-- row computed from versions read earlier is written only if nothing changed since (ADR 0168 §3).
ALTER TABLE entries ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

-- Downloads as last folded into the index. `downloads` counts every fetch; the scheduled
-- aggregation copies it here and moves the entry's stamp once, so `since` answers carry new
-- totals without a stamp per download.
ALTER TABLE versions ADD COLUMN counted INTEGER NOT NULL DEFAULT 0;
