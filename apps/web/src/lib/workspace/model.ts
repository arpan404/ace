import * as z from "zod/mini";

/*
 * The workspace model: which resources are open in the side panel beside a scope's main column
 * (a thread's conversation), in what order, which one is showing, and how wide the panel is.
 *
 * A tab is one opened resource (a file, a browser page, Changes, a terminal). The panel shows
 * one tab at a time; hiding it keeps its tabs, closing a tab removes one resource.
 *
 * Pure functions over immutable values: every operation returns the same object when nothing
 * changed, so subscribers can compare by identity.
 */

export interface WorkspaceTab {
  /** `kind` for a singleton, `kind:id` otherwise. Unique within a scope. */
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

export interface ScopeWorkspace {
  tabs: readonly WorkspaceTab[];
  active: string | undefined;
  /** The side panel shows. Hiding it keeps its tabs. */
  open: boolean;
  /** This scope's width; undefined follows the preferred width. */
  size: number | undefined;
  /** The panel fills the work area and the main column steps aside. */
  expanded: boolean;
}

export interface OpenRequest {
  kind: string;
  /** Instance id; omitted for a singleton, whose key is its kind. */
  id?: string | undefined;
  title?: string | undefined;
  data?: unknown;
  pinned?: boolean | undefined;
}

export const tabKey = (kind: string, id?: string): string =>
  id === undefined || id === kind ? kind : `${kind}:${id}`;

export const emptyWorkspace: ScopeWorkspace = {
  tabs: [],
  active: undefined,
  open: false,
  size: undefined,
  expanded: false,
};

/** A workspace holding these tabs, hidden, the first one active. */
export function seedWorkspace(requests: readonly OpenRequest[]): ScopeWorkspace {
  let workspace = emptyWorkspace;
  for (const request of requests) workspace = openTab(workspace, request, { reveal: false });
  return patch(workspace, { active: workspace.tabs[0]?.key });
}

export function findTab(
  workspace: ScopeWorkspace,
  key: string,
): { tab: WorkspaceTab; index: number } | undefined {
  const index = workspace.tabs.findIndex((tab) => tab.key === key);
  const tab = workspace.tabs[index];
  return tab ? { tab, index } : undefined;
}

/** The tab the panel shows: its active tab, or its first when the active one is gone. */
export function shownTab(workspace: ScopeWorkspace): WorkspaceTab | undefined {
  return workspace.tabs.find((tab) => tab.key === workspace.active) ?? workspace.tabs[0];
}

function patch(workspace: ScopeWorkspace, change: Partial<ScopeWorkspace>): ScopeWorkspace {
  const changed = (Object.keys(change) as (keyof ScopeWorkspace)[]).some(
    (key) => change[key] !== workspace[key],
  );
  if (!changed) return workspace;
  const next = { ...workspace, ...change };
  // An empty or hidden panel has nothing to fill the work area with.
  if (next.expanded && (!next.open || !next.tabs.length)) next.expanded = false;
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

function tabOf(request: OpenRequest): WorkspaceTab {
  return {
    key: tabKey(request.kind, request.id),
    kind: request.kind,
    id: request.id ?? request.kind,
    pinned: request.pinned ?? false,
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.data === undefined ? {} : { data: request.data }),
  };
}

/**
 * Open a resource: show it if it is already open (with `data` applied), otherwise add it to the
 * end of its group. `reveal` also shows the panel.
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
  return patch(workspace, {
    tabs: insert(workspace.tabs, tabOf(request)),
    ...(reveal ? { active: key, open: true } : {}),
  });
}

/** Show a tab and the panel. */
export function activateTab(workspace: ScopeWorkspace, key: string): ScopeWorkspace {
  return findTab(workspace, key) ? patch(workspace, { active: key, open: true }) : workspace;
}

/** Close one resource. Its nearest neighbour takes over; a panel left empty hides. */
export function closeTab(workspace: ScopeWorkspace, key: string): ScopeWorkspace {
  const found = findTab(workspace, key);
  if (!found) return workspace;
  const tabs = workspace.tabs.filter((_, at) => at !== found.index);
  const active =
    workspace.active === key ? neighbour(workspace.tabs, found.index) : workspace.active;
  return patch(workspace, { tabs, active, open: workspace.open && tabs.length > 0 });
}

/** Close every unpinned tab but this one. */
export function closeOtherTabs(workspace: ScopeWorkspace, key: string): ScopeWorkspace {
  if (!findTab(workspace, key)) return workspace;
  const tabs = workspace.tabs.filter((tab) => tab.pinned || tab.key === key);
  return patch(workspace, {
    tabs: tabs.length === workspace.tabs.length ? workspace.tabs : tabs,
    active: key,
  });
}

/** Reorder; pinned and unpinned tabs stay in their own groups. */
export function moveTab(workspace: ScopeWorkspace, key: string, toIndex: number): ScopeWorkspace {
  const found = findTab(workspace, key);
  if (!found) return workspace;
  const rest = workspace.tabs.filter((tab) => tab.key !== key);
  const tabs = insert(rest, found.tab, toIndex);
  const same = tabs.every((tab, index) => tab === workspace.tabs[index]);
  return same ? workspace : patch(workspace, { tabs });
}

export function setTabPinned(
  workspace: ScopeWorkspace,
  key: string,
  pinned: boolean,
): ScopeWorkspace {
  const found = findTab(workspace, key);
  if (!found || found.tab.pinned === pinned) return workspace;
  const rest = workspace.tabs.filter((tab) => tab.key !== key);
  // Pinning puts it last among the pinned; unpinning first among the rest.
  const tabs = insert(rest, { ...found.tab, pinned }, pinned ? undefined : pinnedCount(rest));
  return patch(workspace, { tabs });
}

/**
 * Replace one tab with another resource in its place (the new-tab launcher becoming the tool
 * picked from it). A resource already open shows where it is; nothing opens twice. Replacing
 * keeps the panel's visibility, so a terminal finishing startup cannot reopen a panel the person
 * just hid.
 */
export function replaceTab(
  workspace: ScopeWorkspace,
  key: string,
  request: OpenRequest,
): ScopeWorkspace {
  const found = findTab(workspace, key);
  if (!found) return workspace;
  const nextKey = tabKey(request.kind, request.id);
  const open = workspace.open;
  if (nextKey === key) return patch(workspace, { active: key });
  // Already open: show it where it is; the launcher's job is done.
  if (findTab(workspace, nextKey)) {
    const shown =
      request.data === undefined
        ? workspace
        : updateTab(workspace, nextKey, { data: request.data });
    return patch(closeTab(shown, key), { active: nextKey, open });
  }
  const rest = workspace.tabs.filter((tab) => tab.key !== key);
  return patch(workspace, {
    tabs: insert(rest, tabOf(request), found.index),
    active: nextKey,
    open,
  });
}

export function updateTab(
  workspace: ScopeWorkspace,
  key: string,
  change: { title?: string; data?: unknown },
): ScopeWorkspace {
  const found = findTab(workspace, key);
  if (!found) return workspace;
  const title = change.title ?? found.tab.title;
  const data = "data" in change ? change.data : found.tab.data;
  if (title === found.tab.title && data === found.tab.data) return workspace;
  const tab: WorkspaceTab = { ...found.tab, title, data };
  return patch(workspace, { tabs: workspace.tabs.map((each) => (each.key === key ? tab : each)) });
}

/** Show the next (`delta` 1) or previous (-1) tab, wrapping around. */
export function cycleTab(workspace: ScopeWorkspace, delta: 1 | -1): ScopeWorkspace {
  const { tabs } = workspace;
  if (!tabs.length) return workspace;
  const current = tabs.findIndex((tab) => tab.key === shownTab(workspace)?.key);
  const next = tabs[(current + delta + tabs.length) % tabs.length];
  return next ? patch(workspace, { active: next.key, open: true }) : workspace;
}

export function setPanelOpen(workspace: ScopeWorkspace, open: boolean): ScopeWorkspace {
  return patch(workspace, { open });
}

export function setPanelSize(workspace: ScopeWorkspace, size: number): ScopeWorkspace {
  return patch(workspace, { size: Math.round(size) });
}

/** Full view: the panel fills the work area. Only a panel with tabs can. */
export function setExpanded(workspace: ScopeWorkspace, expanded: boolean): ScopeWorkspace {
  if (expanded === workspace.expanded) return workspace;
  if (expanded && !workspace.tabs.length) return workspace;
  return { ...workspace, expanded, open: expanded ? true : workspace.open };
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
const PanelSchema = z.object({
  tabs: z.array(TabSchema),
  active: z.optional(z.string()),
  open: z.boolean(),
  size: z.optional(z.number()),
});
const CurrentSchema = z.object({
  ...PanelSchema.shape,
  expanded: z.catch(z.boolean(), false),
});
/** Before 0.9 a scope had a side panel (`right`) and a bottom panel (terminals, logs). */
const LegacySchema = z.object({
  right: PanelSchema,
  bottom: z.optional(PanelSchema),
  expanded: z.catch(z.boolean(), false),
});
export const ScopeWorkspaceSchema = z.union([CurrentSchema, LegacySchema]);
type Stored = z.infer<typeof ScopeWorkspaceSchema>;

/**
 * An older entry's two panels as the one side panel: the side panel's tabs, then the bottom
 * panel's (its terminals and logs). Whichever panel showed stays showing, the side one first.
 */
function migrate(stored: Stored): z.infer<typeof CurrentSchema> {
  if (!("right" in stored)) return stored;
  const { right, bottom } = stored;
  const showing = right.open ? right : bottom?.open ? bottom : right;
  return {
    tabs: [...right.tabs, ...(bottom?.tabs ?? [])],
    active: showing.active ?? right.active,
    open: right.open || (bottom?.open ?? false),
    size: right.size,
    expanded: stored.expanded,
  };
}

/** Drop what a hand-edited or older entry could carry that the model never makes. */
export function sanitize(stored: Stored): ScopeWorkspace {
  const workspace = migrate(stored);
  const seen = new Set<string>();
  const tabs = workspace.tabs.filter((tab) => !seen.has(tab.key) && seen.add(tab.key));
  const ordered = [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
  const active = ordered.some((tab) => tab.key === workspace.active) ? workspace.active : undefined;
  const open = workspace.open && ordered.length > 0;
  return {
    tabs: ordered,
    active: active ?? ordered[0]?.key,
    open,
    size: workspace.size,
    expanded: workspace.expanded && open,
  };
}
