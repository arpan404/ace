import type { Store } from "./store.ts";

const tableExists = (store: Pick<Store, "statement">, name: string) =>
  store.statement("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !==
  undefined;

/**
 * Every folder `host.open` treats as inside a project: registered projects (an unregistered one
 * no longer counts) and the checkouts of threads that aren't deleted.
 */
export function openableProjectFolders(store: Pick<Store, "statement">): string[] {
  const projects = tableExists(store, "workspace_unregistered")
    ? "SELECT path FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM workspace_unregistered u WHERE u.workspace_id=w.id)"
    : "SELECT path FROM workspaces";
  const folders = store.statement(projects).all();
  if (tableExists(store, "engine_sessions"))
    folders.push(
      ...store
        .statement(
          "SELECT e.cwd AS path FROM engine_sessions e JOIN threads t ON t.id=e.thread_id WHERE e.workspace_ready=1 AND json_extract(t.client,'$.deletedAt') IS NULL",
        )
        .all(),
    );
  return folders.flatMap((row) => (typeof row.path === "string" ? [row.path] : []));
}
