import type { WorkspaceId } from "@ace/protocol";
import { decodeProjectRow, projectSelect } from "../project-storage.ts";
import type { Store } from "../store.ts";

/** A registered project's checkout and its Edit project check command, if it has one. */
export function projectCheck(
  store: Store,
  workspaceId: WorkspaceId,
): { path: string; checkCommand?: string } | undefined {
  const row = store.atomic((db) =>
    db
      .prepare(
        `${projectSelect} WHERE w.id=? AND NOT EXISTS (SELECT 1 FROM workspace_unregistered WHERE workspace_id=w.id)`,
      )
      .get(workspaceId),
  );
  if (!row) return undefined;
  const project = decodeProjectRow(row);
  const command = project.defaults?.checkCommand;
  return { path: project.path, ...(command ? { checkCommand: command } : {}) };
}
