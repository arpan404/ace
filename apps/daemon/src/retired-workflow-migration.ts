/** Forward-only cleanup. Journal rows remain available through lenient replay decoding. */
export const retiredWorkflowMigration = `
  CREATE TABLE IF NOT EXISTS offshift_runs (
    thread_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(thread_id,id)
  );
  UPDATE threads SET status='{"state":"done"}'
    WHERE id IN (SELECT thread_id FROM offshift_runs)
      AND json_extract(status,'$.state')='working'
      AND NOT EXISTS (SELECT 1 FROM view_entities v WHERE v.thread_id=threads.id
        AND ((v.collection='agents' AND json_extract(v.value,'$.status.state')
          IN ('starting','working','blocked','unresponsive'))
          OR (v.collection='backgroundTasks' AND json_extract(v.value,'$.status')='running')
          OR (v.collection='queue' AND json_extract(v.value,'$.pendingCount')>0)
          OR (v.collection='interactions' AND json_extract(v.value,'$.state')='pending')));
  UPDATE threads SET provider_metadata=json_remove(provider_metadata,'$.run')
    WHERE json_type(provider_metadata,'$.run') IS NOT NULL;
  DELETE FROM view_entities WHERE collection='offshift';
  DROP TABLE IF EXISTS offshift_receipts;
  DROP TABLE offshift_runs;
`;
