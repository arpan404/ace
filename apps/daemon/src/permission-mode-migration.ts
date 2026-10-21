import type { DatabaseSync } from "node:sqlite";
import { AccessMode } from "@ace/protocol";

const marker = "recorded-permission-modes-v1";
const aceModes = `(${AccessMode.options.map((mode) => `'${mode}'`).join(",")})`;

/** JSON-set expression that keeps an ace mode at `path` and nulls anything older. */
function onlyAceMode(column: string, path: string): string {
  return `CASE WHEN json_extract(${column},'${path}') IN ${aceModes} THEN json_extract(${column},'${path}') ELSE NULL END`;
}
function rewritePermission(column: string, at: string): string {
  return `json_set(${column},'${at}.override',${onlyAceMode(column, `${at}.override`)},'${at}.effective',${onlyAceMode(column, `${at}.effective`)})`;
}
/** A recorded state holding a value that isn't an ace mode. */
function stale(column: string, at: string): string {
  return (
    `json_extract(${column},'${at}') IS NOT NULL AND (` +
    `(json_extract(${column},'${at}.override') IS NOT NULL AND json_extract(${column},'${at}.override') NOT IN ${aceModes}) OR ` +
    `(json_extract(${column},'${at}.effective') IS NOT NULL AND json_extract(${column},'${at}.effective') NOT IN ${aceModes}))`
  );
}

/**
 * Permission states recorded before the four ace modes (ADR 0075) keep ace modes and read older
 * native ids as unset: thread rows and `thread.updated`/`thread.created` events. Every write since
 * records ace modes, so the pass runs once per database. It reads the whole event history, which
 * on a large database takes seconds of synchronous I/O; repeating it on every start froze startup.
 */
export function mapRecordedPermissionModes(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM upgrade_cleanup WHERE id=?").get(marker)) return;
  // The `type` column narrows the event scan without parsing every payload's JSON.
  db.exec(`
    UPDATE threads SET provider_metadata=${rewritePermission("provider_metadata", "$.permission")}
      WHERE provider_metadata IS NOT NULL AND ${stale("provider_metadata", "$.permission")};
    UPDATE events SET payload=${rewritePermission("payload", "$.permission")}
      WHERE type='thread.updated' AND ${stale("payload", "$.permission")};
    UPDATE events SET payload=${rewritePermission("payload", "$.thread.permission")}
      WHERE type='thread.created' AND ${stale("payload", "$.thread.permission")};
  `);
  db.prepare("INSERT INTO upgrade_cleanup VALUES (?)").run(marker);
}
