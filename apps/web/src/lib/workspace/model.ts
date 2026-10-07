import * as z from "zod/mini";

/*
 * The workspace model: which resources are open beside a scope's main column (a thread's
 * conversation), in which dock, in what order, which one is showing, and how big each dock is.
 *
 * A tab is one opened resource (a file, a browser page, Changes, a terminal). A dock is a
 * rectangle that shows one tab at a time: `right` beside the column, `bottom` below the column
 * and the right dock. Hiding a dock keeps its tabs; closing a tab removes one resource.
 *
 * Pure functions over immutable values: every operation returns the same object when nothing
 * changed, so subscribers can compare by identity.
 */

export type Dock = "right" | "bottom";
export const docks: readonly Dock[] = ["right", "bottom"];

export interface WorkspaceTab {
  /** `kind` for a singleton, `kind:id` otherwise. Unique across both docks of a scope. */
  key: string;
  kind: string;
  id: string;
  /** The last title the tab's view reported, shown before its code loads. */
  title?: string | undefined;
  /** Pinned tool tabs sit first and have no close button. */
  pinned: boolean;
  /** JSON the kind keeps with the tab (a path, an address); it survives reloads. */
  data?: unknown;
}

export interface DockState {
  tabs: readonly WorkspaceTab[];
  active: string | undefined;
  open: boolean;
  /** This scope's size; undefined follows the preferred size. */
  size: number | undefined;
}

export interface ScopeWorkspace {
  right: DockState;
  bottom: DockState;
  /** The right dock fills the work area and the main column steps aside. */
  expanded: boolean;
  /** The bottom dock takes all the height it may. */
  bottomMaximized: boolean;
  /** The summary card stays open over the main column (pinned) for this scope. */
  summaryPinned: boolean;
}

export interface OpenRequest {
  kind: string;
  /** Instance id; omitted for a singleton, whose key is its kind. */
  id?: string | undefined;
  title?: string | undefined;
  data?: unknown;
  dock: Dock;
  pinned?: boolean | undefined;
}

export const tabKey = (kind: string, id?: string): string =>
  id === undefined || id === kind ? kind : `${kind}:${id}`;

const emptyDock: DockState = { tabs: [], active: undefined, open: false, size: undefined };
export const emptyWorkspace: ScopeWorkspace = {
  right: emptyDock,
  bottom: emptyDock,
  expanded: false,
  bottomMaximized: false,
  summaryPinned: false,
};

/** A workspace holding these tabs, closed, the first of each dock active. */
export function seedWorkspace(requests: readonly OpenRequest[]): ScopeWorkspace {
  let workspace = emptyWorkspace;
  for (const request of requests) workspace = openTab(workspace, request, { reveal: false });
  for (const dock of docks) {
    const first = workspace[dock].tabs[0];
    workspace = withDock(workspace, dock, { active: first?.key });
  }
  return workspace;
}

export function findTab(
  workspace: ScopeWorkspace,
  key: string,
): { dock: Dock; tab: WorkspaceTab; index: number } | undefined {
  for (const dock of docks) {
    const index = workspace[dock].tabs.findIndex((tab) => tab.key === key);
    const tab = workspace[dock].tabs[index];
    if (tab) return { dock, tab, index };
  }
  return undefined;
}

/** The tab a dock shows: its active tab, or its first when the active one is gone. */
export function shownTab(state: DockState): WorkspaceTab | undefined {
  return state.tabs.find((tab) => tab.key === state.active) ?? state.tabs[0];
}

function withDock(
  workspace: ScopeWorkspace,
  dock: Dock,
  patch: Partial<DockState>,
): ScopeWorkspace {
  const current = workspace[dock];
  const changed = (Object.keys(patch) as (keyof DockState)[]).some(
    (key) => patch[key] !== current[key],
  );
  if (!changed) return workspace;
  const next = { ...workspace, [dock]: { ...current, ...patch } };
  // An empty right dock has nothing to fill the work area with.
  if (dock === "right" && next.expanded && (!next.right.open || !next.right.tabs.length))
    next.expanded = false;
  return next;
}

const pinnedCount = (tabs: readonly WorkspaceTab[]) => tabs.filter((tab) => tab.pinned).length;

/** Insert keeping pinned tabs first: at `index` if it is inside the tab's group, else its end. */
function insert(tabs: readonly WorkspaceTab[], tab: WorkspaceTab, index?: number) {
  const pinned = pinnedCount(tabs);
  const [low, high] = tab.pinned ? [0, pinned] : [pinned, tabs.length];
  const at = index === undefined ? high : Math.min(Math.max(index, low), high);
  return [...tabs.slice(0, at), tab, ...tabs.slice(at)];
}

/** The tab that takes over when `index` leaves: the one after it, else the one before. */
function neighbour(tabs: readonly WorkspaceTab[], index: number): string | undefined {
  return (tabs[index + 1] ?? tabs[index - 1])?.key;
}

function removeAt(workspace: ScopeWorkspace, dock: Dock, index: number): ScopeWorkspace {
  const state = workspace[dock];
  const tab = state.tabs[index];
  if (!tab) return workspace;
  const tabs = state.tabs.filter((_, at) => at !== index);
  const active = state.active === tab.key ? neighbour(state.tabs, index) : state.active;
  return withDock(workspace, dock, { tabs, active, open: state.open && tabs.length > 0 });
}

/**
 * Open a resource: show it if it is already open (in whichever dock holds it, with `data`
 * applied), otherwise add it to the end of its group in `request.dock`. `reveal` also shows
 * the dock.
 */
export function openTab(
  workspace: ScopeWorkspace,
  request: OpenRequest,
  options: { reveal?: boolean } = {},
): ScopeWorkspace {
  const reveal = options.reveal ?? true;
  const key = tabKey(request.kind, request.id);
  const found = findTab(workspace, key);
  if (found) {
    let next = workspace;
    if (request.data !== undefined && request.data !== found.tab.data)
      next = updateTab(next, key, { data: request.data });
    return reveal ? activateTab(next, key) : next;
  }
  const tab: WorkspaceTab = {
    key,
    kind: request.kind,
    id: request.id ?? request.kind,
    pinned: request.pinned ?? false,
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.data === undefined ? {} : { data: request.data }),
  };
  const state = workspace[request.dock];
  return withDock(workspace, request.dock, {
    tabs: insert(state.tabs, tab),
    ...(reveal ? { active: key, open: true } : {}),
  });
}

/** Show a tab and its dock. */
export function activateTab(workspace: ScopeWorkspace, key: string): ScopeWorkspace {
  const found = findTab(workspace, key);
  if (!found) return workspace;
  return withDock(workspace, found.dock, { active: key, open: true });
}

/** Close one resource. Its nearest neighbour takes over; a dock left empty hides. */
export function closeTab(workspace: ScopeWorkspace, key: string): ScopeWorkspace {
  const found = findTab(workspace, key);
  return found ? removeAt(workspace, found.dock, found.index) : workspace;
}

/** Close every unpinned tab of the dock but this one. */
export function closeOtherTabs(workspace: ScopeWorkspace, key: string): ScopeWorkspace {
  const found = findTab(workspace, key);
  if (!found) return workspace;
  const tabs = workspace[found.dock].tabs.filter((tab) => tab.pinned || tab.key === key);
  return withDock(workspace, found.dock, { tabs, active: key });
}

/** Reorder within a dock; pinned and unpinned tabs stay in their own groups. */
export function moveTab(workspace: ScopeWorkspace, key: string, toIndex: number): ScopeWorkspace {
  const found = findTab(workspace, key);
  if (!found) return workspace;
  const rest = workspace[found.dock].tabs.filter((tab) => tab.key !== key);
  const tabs = insert(rest, found.tab, toIndex);
  const same = tabs.every((tab, index) => tab === workspace[found.dock].tabs[index]);
  return same ? workspace : withDock(workspace, found.dock, { tabs });
}

/** Move a tab to the other dock (at `index`, else the end of its group) and show it there. */
export function moveTabToDock(
  workspace: ScopeWorkspace,
  key: string,
  dock: Dock,
  index?: number,
): ScopeWorkspace {
  const found = findTab(workspace, key);
  if (!found) return workspace;
  if (found.dock === dock) return index === undefined ? workspace : moveTab(workspace, key, index);
  const removed = removeAt(workspace, found.dock, found.index);
  return withDock(removed, dock, {
    tabs: insert(removed[dock].tabs, found.tab, index),
    active: key,
    open: true,
  });
}

export function setTabPinned(
  workspace: ScopeWorkspace,
  key: string,
  pinned: boolean,
): ScopeWorkspace {
  const found = findTab(workspace, key);
  if (!found || found.tab.pinned === pinned) return workspace;
  const rest = workspace[found.dock].tabs.filter((tab) => tab.key !== key);
  // Pinning puts it last among the pinned; unpinning first among the rest.
  const tabs = insert(rest, { ...found.tab, pinned }, pinned ? undefined : pinnedCount(rest));
  return withDock(workspace, found.dock, { tabs });
}

/**
 * Replace one tab with another resource in its place (the new-tab launcher becoming the tool
 * picked from it). A resource already open in this dock shows where it is; one open in the
 * other dock moves here. Nothing opens twice. Replacing a resource keeps its dock's visibility,
 * so a terminal finishing startup cannot reopen a dock the person just hid.
 */
export function replaceTab(
  workspace: ScopeWorkspace,
  key: string,
  request: Omit<OpenRequest, "dock">,
): ScopeWorkspace {
  const found = findTab(workspace, key);
  if (!found) return workspace;
  const nextKey = tabKey(request.kind, request.id);
  if (nextKey === key)
    return setDockOpen(activateTab(workspace, key), found.dock, workspace[found.dock].open);
  const existing = findTab(workspace, nextKey);
  // Already open in this dock: show it where it is; the launcher's job is done.
  if (existing?.dock === found.dock) {
    const shown =
      request.data === undefined
        ? workspace
        : updateTab(workspace, nextKey, { data: request.data });
    return setDockOpen(
      activateTab(closeTab(shown, key), nextKey),
      found.dock,
      workspace[found.dock].open,
    );
  }
  let next = removeAt(workspace, found.dock, found.index);
  let tab: WorkspaceTab;
  if (existing) {
    next = closeTab(next, nextKey);
    tab = request.data === undefined ? existing.tab : { ...existing.tab, data: request.data };
  } else {
    tab = {
      key: nextKey,
      kind: request.kind,
      id: request.id ?? request.kind,
      pinned: request.pinned ?? false,
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.data === undefined ? {} : { data: request.data }),
    };
  }
  return withDock(next, found.dock, {
    tabs: insert(next[found.dock].tabs, tab, found.index),
    active: nextKey,
    open: workspace[found.dock].open,
  });
}

export function updateTab(
  workspace: ScopeWorkspace,
  key: string,
  patch: { title?: string; data?: unknown },
): ScopeWorkspace {
  const found = findTab(workspace, key);
  if (!found) return workspace;
  const title = patch.title ?? found.tab.title;
  const data = "data" in patch ? patch.data : found.tab.data;
  if (title === found.tab.title && data === found.tab.data) return workspace;
  const tab: WorkspaceTab = { ...found.tab, title, data };
  const tabs = workspace[found.dock].tabs.map((each) => (each.key === key ? tab : each));
  return withDock(workspace, found.dock, { tabs });
}

/** Show the next (`delta` 1) or previous (-1) tab of a dock, wrapping around. */
export function cycleTab(workspace: ScopeWorkspace, dock: Dock, delta: 1 | -1): ScopeWorkspace {
  const state = workspace[dock];
  if (!state.tabs.length) return workspace;
  const current = state.tabs.findIndex((tab) => tab.key === shownTab(state)?.key);
  const next = state.tabs[(current + delta + state.tabs.length) % state.tabs.length];
  return next ? withDock(workspace, dock, { active: next.key, open: true }) : workspace;
}

export function setDockOpen(workspace: ScopeWorkspace, dock: Dock, open: boolean): ScopeWorkspace {
  return withDock(workspace, dock, { open });
}

export function setDockSize(workspace: ScopeWorkspace, dock: Dock, size: number): ScopeWorkspace {
  return withDock(workspace, dock, { size: Math.round(size) });
}

/** Full view: the right dock fills the work area. Only a right dock with tabs can. */
export function setExpanded(workspace: ScopeWorkspace, expanded: boolean): ScopeWorkspace {
  if (expanded === workspace.expanded) return workspace;
  if (expanded && !workspace.right.tabs.length) return workspace;
  return {
    ...workspace,
    expanded,
    right: expanded ? { ...workspace.right, open: true } : workspace.right,
  };
}

export function setBottomMaximized(workspace: ScopeWorkspace, maximized: boolean): ScopeWorkspace {
  if (maximized === workspace.bottomMaximized) return workspace;
  return {
    ...workspace,
    bottomMaximized: maximized,
    bottom: maximized ? { ...workspace.bottom, open: true } : workspace.bottom,
  };
}

export function setSummaryPinned(workspace: ScopeWorkspace, pinned: boolean): ScopeWorkspace {
  return pinned === workspace.summaryPinned ? workspace : { ...workspace, summaryPinned: pinned };
}

// ---------------------------------------------------------------------------------------------
// Persistence. Storage is outside the process, so it is parsed; a bad entry falls back.

const TabSchema = z.object({
  key: z.string().check(z.minLength(1)),
  kind: z.string().check(z.minLength(1)),
  id: z.string().check(z.minLength(1)),
  title: z.optional(z.string()),
  pinned: z.boolean(),
  data: z.optional(z.unknown()),
});
const DockSchema = z.object({
  tabs: z.array(TabSchema),
  active: z.optional(z.string()),
  open: z.boolean(),
  size: z.optional(z.number()),
});
export const ScopeWorkspaceSchema = z.object({
  right: DockSchema,
  bottom: DockSchema,
  expanded: z.boolean(),
  bottomMaximized: z.catch(z.boolean(), false),
  summaryPinned: z.catch(z.boolean(), false),
});

/** Drop what a hand-edited or older entry could carry that the model never makes. */
export function sanitize(workspace: z.infer<typeof ScopeWorkspaceSchema>): ScopeWorkspace {
  const seen = new Set<string>();
  const dock = (state: z.infer<typeof DockSchema>): DockState => {
    const tabs = state.tabs.filter((tab) => !seen.has(tab.key) && seen.add(tab.key));
    const ordered = [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
    const active = ordered.some((tab) => tab.key === state.active) ? state.active : undefined;
    return {
      tabs: ordered,
      active: active ?? ordered[0]?.key,
      open: state.open && ordered.length > 0,
      size: state.size,
    };
  };
  const right = dock(workspace.right);
  return {
    right,
    bottom: dock(workspace.bottom),
    expanded: workspace.expanded && right.open,
    bottomMaximized: workspace.bottomMaximized,
    summaryPinned: workspace.summaryPinned,
  };
}
