import type { DatabaseSync } from "node:sqlite";

/** Remove features newer than schema five before building an older database fixture. */
export function restorePrePreviewSchema(db: DatabaseSync): void {
  db.exec(`ALTER TABLE threads DROP COLUMN acp;
    DROP TABLE usage_deletions;
    DROP TABLE history_blob_chunks; DROP TABLE history_blobs;
    DROP INDEX imported_source; ALTER TABLE threads DROP COLUMN imported;
    DROP TABLE item_source_chunks; DROP TABLE item_text_streams;
    DROP TABLE item_previews; DROP TABLE item_preview_migration;`);
}
