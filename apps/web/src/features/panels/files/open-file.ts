import { findTab, type WorkspaceActions, type ScopeWorkspace } from "@/lib/workspace/index.ts";
import { fileTabData } from "./files-state.ts";
import { fileTabId } from "./tab-id.ts";

export interface OpenFileOptions {
  /** A deliberate open (Enter, double-click, quick open): the tab stays. Else a preview. */
  keep?: boolean;
  /** The tab the pick came from (its tree): an empty or preview tab turns into the file. */
  from?: string | undefined;
  line?: number | undefined;
}

/**
 * Open a checkout file the way the Files tool does: a tab already showing it comes forward; a
 * single click reuses the tab it came from when that tab is empty or a preview (or any other
 * preview tab), so browsing a tree doesn't pile up tabs; a deliberate open keeps its tab.
 */
export function openFile(
  workspace: ScopeWorkspace,
  actions: WorkspaceActions,
  path: string,
  options: OpenFileOptions = {},
): void {
  const id = fileTabId(path);
  const keep = options.keep ?? false;
  const line = options.line === undefined ? {} : { line: options.line };
  const existing = findTab(workspace, `files:${id}`);
  if (existing) {
    const data = fileTabData(existing.tab);
    actions.open({
      kind: "files",
      id,
      data: { ...data, path, ...line, preview: keep ? false : data.preview },
    });
    return;
  }
  const data = { path, preview: !keep, ...line };
  const replaceable = (key: string | undefined) => {
    const found = key ? findTab(workspace, key) : undefined;
    if (found?.tab.kind !== "files") return undefined;
    const current = fileTabData(found.tab);
    return !current.path || current.preview ? found.tab.key : undefined;
  };
  const target =
    replaceable(options.from) ??
    workspace.right.tabs.map((tab) => replaceable(tab.key)).find((key) => key !== undefined);
  if (target) actions.replace(target, { kind: "files", id, data });
  else actions.open({ kind: "files", id, data });
}
