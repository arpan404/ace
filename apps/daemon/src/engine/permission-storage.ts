import { ThreadId as importThreadId, AccessMode } from "@ace/protocol";
import type { PermissionState, ProviderKind } from "@ace/protocol";
import { storedAccess } from "@ace/provider-kit/access-modes";
import { z } from "zod";
import type { EngineRepository } from "./repository.ts";

export const PermissionRecord = z.object({
  override: z.string().nullable(),
  effective: z.string().nullable(),
  parent: z.string().nullable(),
  ceiling_provider: z
    .enum(["claude", "codex", "opencode", "cursor", "pi", "acp", "antigravity"])
    .nullable(),
  ceiling_mode: z.string().nullable(),
  ceiling_identity: z.string().nullable(),
});
export type PermissionRecord = z.infer<typeof PermissionRecord>;

/**
 * One-time load mapping of a selection stored before the four ace modes (ADR 0075): native ids
 * become the ace mode the migration table names, or null (the defaults) without one.
 */
export function migrateSelection(provider: ProviderKind, stored: string | null): string | null {
  if (stored === null || stored.startsWith("custom:")) return stored;
  return storedAccess(provider, stored) ?? null;
}

export function permissionState(record: PermissionRecord): PermissionState {
  const override = AccessMode.safeParse(record.override);
  const effective = AccessMode.safeParse(record.effective);
  return {
    override: override.success ? override.data : null,
    effective: effective.success ? effective.data : null,
    ...(record.effective?.startsWith("custom:") ? { custom: record.effective.slice(7) } : {}),
    pending: record.override !== null && record.override !== record.effective,
  };
}

const aceModes = "('read-only','ask','auto-review','full-access')";
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
 * One-time load mapping of permission states written before the four ace modes: recorded
 * thread rows and `thread.updated`/`thread.created` events keep ace modes and read older
 * native ids as unset. The current mode is republished by `migratePermissions`.
 */
export function migrateRecordedPermissionStates(repo: EngineRepository): void {
  repo.store.atomic((db) =>
    db.exec(`
      UPDATE threads SET provider_metadata=${rewritePermission("provider_metadata", "$.permission")}
        WHERE provider_metadata IS NOT NULL AND ${stale("provider_metadata", "$.permission")};
      UPDATE events SET payload=${rewritePermission("payload", "$.permission")}
        WHERE json_extract(payload,'$.type')='thread.updated' AND ${stale("payload", "$.permission")};
      UPDATE events SET payload=${rewritePermission("payload", "$.thread.permission")}
        WHERE json_extract(payload,'$.type')='thread.created' AND ${stale("payload", "$.thread.permission")};
    `),
  );
}

export function createPermissionTables(repo: EngineRepository): void {
  repo.store.atomic((db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS engine_permissions (
        thread_id TEXT PRIMARY KEY, override TEXT, effective TEXT, parent TEXT,
        ceiling_provider TEXT, ceiling_mode TEXT, ceiling_identity TEXT
      );
    `),
  );
}

/**
 * Map every stored selection onto the four modes once, and republish threads whose permission
 * state or capabilities changed, so clients never see a native id as an ace mode.
 */
export function migratePermissions(repo: EngineRepository): void {
  repo.store.atomic((db) => {
    const rows = z
      .array(
        PermissionRecord.extend({ thread_id: z.string() }).partial({
          ceiling_provider: true,
          ceiling_mode: true,
          ceiling_identity: true,
        }),
      )
      .parse(db.prepare("SELECT * FROM engine_permissions").all());
    for (const row of rows) {
      const id = importThreadId.parse(row.thread_id);
      const thread = repo.store.getThread(id);
      if (!thread) continue;
      const record = {
        override: migrateSelection(thread.provider, row.override),
        effective: migrateSelection(thread.provider, row.effective),
        parent: row.parent,
        ceiling_provider: row.ceiling_provider ?? null,
        ceiling_mode: row.ceiling_provider
          ? migrateSelection(row.ceiling_provider, row.ceiling_mode ?? null)
          : null,
        ceiling_identity: row.ceiling_identity ?? null,
      };
      if (
        record.override !== row.override ||
        record.effective !== row.effective ||
        record.ceiling_mode !== (row.ceiling_mode ?? null)
      )
        db.prepare(
          "UPDATE engine_permissions SET override=?,effective=?,ceiling_mode=? WHERE thread_id=?",
        ).run(record.override, record.effective, record.ceiling_mode, id);
      const permission = permissionState(record);
      const shown = thread.permission;
      // Republish only when the mapping changed what clients read, never on a plain restart.
      if (
        shown?.override !== permission.override ||
        shown?.effective !== permission.effective ||
        shown?.custom !== permission.custom
      )
        repo.store.appendEvents(id, [{ type: "thread.updated", permission }], thread.updatedAt);
    }
  });
}
