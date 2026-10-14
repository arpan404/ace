import type { AccessMode, WorkspaceId } from "@ace/protocol";
import { decodeProjectRow, projectSelect } from "./project-storage.ts";
import type { Store } from "./store.ts";

/** The access a project's Edit project defaults name for its new threads, if any. */
export function projectAccess(store: Store, workspaceId: WorkspaceId): AccessMode | undefined {
  const row = store.atomic((db) => db.prepare(`${projectSelect} WHERE w.id=?`).get(workspaceId));
  return row ? decodeProjectRow(row).defaults?.access : undefined;
}
