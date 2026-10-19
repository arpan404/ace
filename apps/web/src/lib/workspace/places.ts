import {
  activateTab,
  closeTab,
  emptyWorkspace,
  findTab,
  openTab,
  replaceTab,
  setPanelOpen,
  shownTab,
  tabKey,
  updateTab,
  type OpenRequest,
  type ScopeWorkspace,
  type WorkspaceTab,
} from "./model.ts";

/*
 * The two places a scope's tabs show: the side panel beside the main column, and the bottom
 * panel under it, which holds only the kinds its definition names (terminals). Each place is a
 * group of tabs with the same rules (`model.ts`): one shows at a time, hiding keeps them. A
 * key is open in one place at most, so a resource never has two live views; moving a tab
 * takes it out of one group and into the other with its identity, title and data.
 *
 * Pure functions over immutable values, returning the same object when nothing changed.
 */

export type PanelPlace = "side" | "bottom";

/** The bottom panel's group (empty until it first opens). */
export const bottomOf = (workspace: ScopeWorkspace): ScopeWorkspace =>
  workspace.bottom ?? emptyWorkspace;

/** Change one place's group; the side panel's is the workspace itself. */
export function inPlace(
  workspace: ScopeWorkspace,
  place: PanelPlace,
  change: (group: ScopeWorkspace) => ScopeWorkspace,
): ScopeWorkspace {
  // The side panel's operations spread the workspace, so they carry the bottom group along.
  if (place === "side") return change(workspace);
  const before = bottomOf(workspace);
  const after = change(before);
  return after === before ? workspace : { ...workspace, bottom: after };
}

/** Where `key` is open, if anywhere. */
export function placeOf(workspace: ScopeWorkspace, key: string): PanelPlace | undefined {
  if (findTab(workspace, key)) return "side";
  return findTab(bottomOf(workspace), key) ? "bottom" : undefined;
}

/** Change the group holding `key` (the side panel's when no group holds it). */
export function atKey(
  workspace: ScopeWorkspace,
  key: string,
  change: (group: ScopeWorkspace) => ScopeWorkspace,
): ScopeWorkspace {
  return inPlace(workspace, placeOf(workspace, key) ?? "side", change);
}

/** A tab wherever it is open. */
export function locateTab(
  workspace: ScopeWorkspace,
  key: string,
): { tab: WorkspaceTab; index: number; place: PanelPlace } | undefined {
  const side = findTab(workspace, key);
  if (side) return { ...side, place: "side" };
  const bottom = findTab(bottomOf(workspace), key);
  return bottom && { ...bottom, place: "bottom" };
}

/** Every open tab, the side panel's first. */
export function allTabs(workspace: ScopeWorkspace): readonly WorkspaceTab[] {
  const bottom = workspace.bottom?.tabs;
  return bottom?.length ? [...workspace.tabs, ...bottom] : workspace.tabs;
}

/** Whether `key` is the tab its place shows, with that place on screen. */
export function isShowing(workspace: ScopeWorkspace, key: string): boolean {
  const place = placeOf(workspace, key);
  if (!place) return false;
  const group = place === "side" ? workspace : bottomOf(workspace);
  return group.open && shownTab(group)?.key === key;
}

/**
 * Open a resource in `place`. One already open anywhere shows where it is instead (with
 * `data` applied), so nothing opens twice. `reveal` (default) shows that place.
 */
export function openIn(
  workspace: ScopeWorkspace,
  place: PanelPlace,
  request: OpenRequest,
  options: { reveal?: boolean } = {},
): ScopeWorkspace {
  const where = placeOf(workspace, tabKey(request.kind, request.id)) ?? place;
  return inPlace(workspace, where, (group) => openTab(group, request, options));
}

/** Show or hide the bottom panel. Showing an empty one opens `fill` in it. */
export function setBottomOpen(
  workspace: ScopeWorkspace,
  open: boolean,
  fill?: OpenRequest,
): ScopeWorkspace {
  return inPlace(workspace, "bottom", (group) => {
    if (!open || group.tabs.length || !fill) return setPanelOpen(group, open);
    return openTab(group, fill);
  });
}

/**
 * Move a tab to the other place, showing it there: same key, title and data, so whatever the
 * tab's view stands for (a terminal's shell) carries on. In the bottom panel it is unpinned.
 * The place it left shows its neighbour, or hides once empty.
 */
export function moveToPlace(
  workspace: ScopeWorkspace,
  key: string,
  place: PanelPlace,
): ScopeWorkspace {
  const found = locateTab(workspace, key);
  if (!found || found.place === place) return workspace;
  const { tab } = found;
  const left = inPlace(workspace, found.place, (group) => closeTab(group, key));
  return inPlace(left, place, (group) => {
    const request = {
      kind: tab.kind,
      id: tab.id,
      title: tab.title,
      data: tab.data,
      pinned: place === "side" && tab.pinned,
    };
    const added = openTab(group, request, { reveal: false });
    return activateTab(tab.ui ? updateTab(added, key, { ui: tab.ui }) : added, key);
  });
}

/**
 * Turn one tab into another resource in its place (`replaceTab`). If that resource is already
 * open in the other place, it stays there and this tab closes: nothing is open twice.
 */
export function replaceAt(
  workspace: ScopeWorkspace,
  key: string,
  request: OpenRequest,
): ScopeWorkspace {
  const from = placeOf(workspace, key);
  if (!from) return workspace;
  const there = placeOf(workspace, tabKey(request.kind, request.id));
  if (!there || there === from)
    return inPlace(workspace, from, (group) => replaceTab(group, key, request));
  const kept = inPlace(workspace, there, (group) => openTab(group, request, { reveal: false }));
  return inPlace(kept, from, (group) => closeTab(group, key));
}
