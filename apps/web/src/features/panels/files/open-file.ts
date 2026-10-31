import { findTab, type WorkspaceActions, type ScopeWorkspace } from "@/lib/workspace/index.ts";
import { fileTabData } from "./files-state.ts";
import { fileTabId } from "./tab-id.ts";

export interface OpenFileOptions {
  /** A deliberate open (Enter, double-click, quick open): the tab stays. Else a preview. */
  keep?: boolean;
  /** The tab the pick came from (its tree): an empty or preview tab turns into the file. */
  from?: string | undefined;
  line?: number | undefined;
  /** The tree choice the tab carries over (a tree laid over the file closes on a pick). */
  tree?: boolean | undefined;
}

/**
 * Open a checkout file the way the Files tool does: a tab already showing it comes forward; a
 * single click reuses the tab it came from when that tab is empty or a preview (or any other
 * preview tab), so browsing a tree doesn't pile up tabs; a deliberate open keeps its tab. The
 * pinned Files tab stays the tree: what it opens goes in a tab beside it.
 */
export function openFile(
  workspace: ScopeWorkspace,
  actions: WorkspaceActions,
  path: string,
  options: OpenFileOptions = {},
): void {
  const id = fileTabId(path);
  const keep = options.keep ?? false;
  const extra = {
    ...(options.line === undefined ? {} : { line: options.line }),
    ...(options.tree === undefined ? {} : { tree: options.tree }),
  };
  const existing = findTab(workspace, `files:${id}`);
  if (existing) {
    const data = fileTabData(existing.tab);
    actions.open({
      kind: "files",
      id,
      data: { ...data, path, ...extra, preview: keep ? false : data.preview },
    });
    return;
  }
  const replaceable = (key: string | undefined) => {
    const found = key ? findTab(workspace, key) : undefined;
    if (found?.tab.kind !== "files" || found.tab.pinned) return undefined;
    const current = fileTabData(found.tab);
    return !current.path || current.preview ? found.tab.key : undefined;
  };
  const target =
    replaceable(options.from) ??
    workspace.tabs.map((tab) => replaceable(tab.key)).find((key) => key !== undefined);
  // The tree beside the file keeps what the person left there: its filter, which folders were
  // folded, and where it was scrolled. A replacement carries its own tree over; a new tab takes
  // its source tab's (or the showing files tab's, for quick open), so browsing files never
  // resets the explorer.
  const inheritKey = target ?? options.from ?? workspace.active;
  const inheritTab = inheritKey ? findTab(workspace, inheritKey)?.tab : undefined;
  const inheritData = inheritTab && inheritTab.kind === "files" ? fileTabData(inheritTab) : {};
  const carried = {
    ...(inheritData.collapsed === undefined ? {} : { collapsed: inheritData.collapsed }),
    ...(inheritData.query === undefined ? {} : { query: inheritData.query }),
    ...(inheritData.treeScroll === undefined ? {} : { treeScroll: inheritData.treeScroll }),
  };
  const data = { ...carried, path, preview: !keep, ...extra };
  if (target) actions.replace(target, { kind: "files", id, data });
  else actions.open({ kind: "files", id, data });
}
