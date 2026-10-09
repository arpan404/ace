import type { DatabaseSync } from "node:sqlite";

/** Seed the sticky message fact for old rows once; never infer it from a title or status. */
export function seedSentMessages(db: DatabaseSync): void {
  const key = "sent-message-v1";
  if (db.prepare("SELECT id FROM upgrade_cleanup WHERE id=?").get(key)) return;
  db.exec(`UPDATE threads SET client=json_set(coalesce(client,'{}'),'$.hasSentMessage',
    json(CASE WHEN EXISTS(SELECT 1 FROM items i WHERE i.thread_id=threads.id
      AND json_extract(i.item,'$.type')='message' AND json_extract(i.item,'$.role')='user'
      AND coalesce(json_extract(i.item,'$.synthetic'),0)!=1) OR EXISTS(
      SELECT 1 FROM history_item_revisions r JOIN history_items h ON h.id=r.item_id
      WHERE h.thread_id=threads.id AND json_extract(r.item,'$.type')='message'
      AND json_extract(r.item,'$.role')='user' AND coalesce(json_extract(r.item,'$.synthetic'),0)!=1)
      THEN 'true' ELSE 'false' END)) WHERE json_type(client,'$.hasSentMessage') IS NULL`);
  db.prepare("INSERT INTO upgrade_cleanup VALUES (?)").run(key);
}
