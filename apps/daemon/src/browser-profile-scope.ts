import { BrowserProfileScope, type SettingsProvenance, type WorkspaceId } from "@ace/protocol";
import { decodeProjectRow, projectSelect } from "./project-storage.ts";
import type { Store } from "./store.ts";

/**
 * Which kept browser profile a thread's browser opens in. A thread's own setting (or an
 * environment override) comes first, then the project's choice in Edit project, then the
 * `browser.profileScope` setting as resolved for the project (its settings file, else the
 * daemon's), else `global`.
 */
export function chooseProfileScope(
  setting: { value: unknown; provenance: SettingsProvenance } | undefined,
  project: BrowserProfileScope | undefined,
): BrowserProfileScope {
  const configured = BrowserProfileScope.safeParse(setting?.value);
  if (
    configured.success &&
    (setting?.provenance === "thread" || setting?.provenance === "environment")
  )
    return configured.data;
  return project ?? (configured.success ? configured.data : "global");
}

/** The browser profile the project's Edit project defaults name, if any. */
export function projectProfileScope(
  store: Store,
  workspaceId: WorkspaceId,
): BrowserProfileScope | undefined {
  const row = store.atomic((db) => db.prepare(`${projectSelect} WHERE w.id=?`).get(workspaceId));
  return row ? decodeProjectRow(row).defaults?.browserProfileScope : undefined;
}
