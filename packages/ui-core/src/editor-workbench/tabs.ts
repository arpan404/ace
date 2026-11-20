import { changeTab, insertGroup, pinnedCount, touch, updateGroup } from "./nodes.ts";
import { adjacentGroup, emptyGroup, findGroup, focusedGroup, groupsOf } from "./tree.ts";
import {
  limits,
  type EditorLayout,
  type EditorTab,
  type GroupNode,
  type NewGroupId,
  type TabRef,
  type ViewState,
} from "./types.ts";

/*
 * Tab rules (spec 9–11, 22, 26): glances and deliberate opens, the one preview per group, pins
 * first in pin order, and MRU order. The model knows paths, not buffers: callers pass the set
 * of paths with unsaved edits where a rule depends on it.
 */

export interface OpenEditorOptions {
  /** `glance` opens or replaces the group's preview tab; `keep` opens a tab that stays. */
  intent: "glance" | "keep";
  /** The group to open in; the focused group when omitted or gone. */
  group?: string | undefined;
  /** Paths with unsaved edits: a preview with unsaved edits is kept, never replaced. */
  unsaved?: ReadonlySet<string> | undefined;
  view?: ViewState | undefined;
}

const noPaths: ReadonlySet<string> = new Set();

/** The group after opening `path` in it by these rules. */
export function openInGroup(group: GroupNode, path: string, options: OpenEditorOptions): GroupNode {
  const keep = options.intent === "keep";
  const withView = (tab: EditorTab): EditorTab =>
    options.view ? { ...tab, view: options.view } : tab;
  const existing = group.tabs.find((tab) => tab.path === path);
  if (existing) {
    const kept = keep && existing.preview ? { ...existing, preview: false } : existing;
    const next = withView(kept);
    return touch(next === existing ? group : changeTab(group, path, () => next), path);
  }
  const fresh = withView({ path, preview: !keep, pinned: false });
  const previewIndex = group.tabs.findIndex((tab) => tab.preview);
  const preview = group.tabs[previewIndex];
  const unsaved = options.unsaved ?? noPaths;
  let tabs = group.tabs;
  let mru = group.mru;
  if (preview && !keep && !unsaved.has(preview.path)) {
    // The glance takes the preview's place, which leaves no trace in the MRU.
    tabs = tabs.map((tab, index) => (index === previewIndex ? fresh : tab));
    mru = mru.filter((each) => each !== preview.path);
    return touch({ ...group, tabs, mru, active: group.active }, path);
  }
  if (preview && (!keep || unsaved.has(preview.path))) {
    // A preview someone typed into is no longer a glance; it stays when the next glance comes.
    tabs = tabs.map((tab, index) => (index === previewIndex ? { ...tab, preview: false } : tab));
  }
  const pins = pinnedCount(tabs);
  const activeIndex = tabs.findIndex((tab) => tab.path === group.active);
  const slot = Math.max(activeIndex >= 0 ? activeIndex + 1 : tabs.length, pins);
  const placed = [...tabs];
  placed.splice(slot, 0, fresh);
  return touch({ ...group, tabs: placed, mru }, path);
}

/** Open a file in a group (spec 9–11): an open tab comes forward, a glance replaces the preview. */
export function openEditor(
  layout: EditorLayout,
  path: string,
  options: OpenEditorOptions,
): EditorLayout {
  const target =
    (options.group === undefined ? undefined : findGroup(layout, options.group)) ??
    focusedGroup(layout);
  const next = updateGroup(layout, target.id, (group) => openInGroup(group, path, options));
  return next.focused === target.id ? next : { ...next, focused: target.id };
}

/** ⌘-click / ⌘↵: open in the group to the right, splitting right when there is none. */
export function openEditorToSide(
  layout: EditorLayout,
  path: string,
  options: OpenEditorOptions,
  newGroupId: NewGroupId,
): EditorLayout {
  const from = focusedGroup(layout);
  const right = adjacentGroup(layout, from.id, "right");
  if (right) return openEditor(layout, path, { ...options, group: right.id });
  if (groupsOf(layout).length >= limits.groups) {
    return openEditor(layout, path, { ...options, group: from.id });
  }
  const id = newGroupId();
  const split = insertGroup(layout, from.id, "right", emptyGroup(id));
  return openEditor(split, path, { ...options, group: id });
}

/** Show a tab: its group gains focus and the tab moves to the front of the group's MRU. */
export function activateTab(layout: EditorLayout, ref: TabRef): EditorLayout {
  const group = findGroup(layout, ref.group);
  if (!group?.tabs.some((tab) => tab.path === ref.path)) return layout;
  const next = updateGroup(layout, ref.group, (each) => touch(each, ref.path));
  return next.focused === ref.group ? next : { ...next, focused: ref.group };
}

/** A preview becomes a kept tab (double-click, typing, dragging). */
export function keepTab(layout: EditorLayout, ref: TabRef): EditorLayout {
  return updateGroup(layout, ref.group, (group) =>
    changeTab(group, ref.path, (tab) => (tab.preview ? { ...tab, preview: false } : tab)),
  );
}

/** Pin a tab: it is kept and moves to the end of the pinned tabs. */
export function pinTab(layout: EditorLayout, ref: TabRef): EditorLayout {
  return updateGroup(layout, ref.group, (group) => {
    const tab = group.tabs.find((each) => each.path === ref.path);
    if (!tab || tab.pinned) return group;
    const rest = group.tabs.filter((each) => each !== tab);
    const tabs = [...rest];
    tabs.splice(pinnedCount(rest), 0, { ...tab, pinned: true, preview: false });
    return { ...group, tabs };
  });
}

/** Unpin a tab: it moves to the first place after the pinned tabs. */
export function unpinTab(layout: EditorLayout, ref: TabRef): EditorLayout {
  return updateGroup(layout, ref.group, (group) => {
    const tab = group.tabs.find((each) => each.path === ref.path);
    if (!tab?.pinned) return group;
    const rest = group.tabs.filter((each) => each !== tab);
    const tabs = [...rest];
    tabs.splice(pinnedCount(rest), 0, { ...tab, pinned: false });
    return { ...group, tabs };
  });
}

export function setViewState(layout: EditorLayout, ref: TabRef, view: ViewState): EditorLayout {
  return updateGroup(layout, ref.group, (group) =>
    changeTab(group, ref.path, (tab) => ({ ...tab, view })),
  );
}

/** The group's tabs in most recently used order (⌃Tab, quick open's empty list). */
export function mruTabs(group: GroupNode): readonly EditorTab[] {
  const byPath = new Map(group.tabs.map((tab) => [tab.path, tab]));
  const ordered: EditorTab[] = [];
  for (const path of group.mru) {
    const tab = byPath.get(path);
    if (!tab) continue;
    ordered.push(tab);
    byPath.delete(path);
  }
  return [...ordered, ...byPath.values()];
}

/** Every view of a path across the groups, in reading order. */
export function viewsOf(layout: EditorLayout, path: string): readonly TabRef[] {
  return groupsOf(layout)
    .filter((group) => group.tabs.some((tab) => tab.path === path))
    .map((group) => ({ group: group.id, path }));
}

export interface TabLabel {
  name: string;
  /** The nearest folder that tells two same-named tabs apart; undefined when the name is unique. */
  folder?: string | undefined;
}

/** Names for a strip or a list (spec 20): same names gain their nearest differing folder. */
export function tabLabels(paths: readonly string[]): readonly TabLabel[] {
  const parts = paths.map((path) => path.split("/").filter(Boolean));
  const nameOf = (segments: readonly string[], path: string) => segments.at(-1) ?? path;
  const byName = new Map<string, number[]>();
  parts.forEach((segments, index) => {
    const name = nameOf(segments, paths[index] ?? "");
    byName.set(name, [...(byName.get(name) ?? []), index]);
  });
  return parts.map((segments, index) => {
    const name = nameOf(segments, paths[index] ?? "");
    const others = (byName.get(name) ?? []).filter((other) => other !== index);
    if (others.length === 0) return { name };
    const folders = segments.slice(0, -1).reverse();
    for (let depth = 0; depth < folders.length; depth += 1) {
      const folder = folders[depth];
      const clashes = others.some((other) => {
        const theirs = parts[other] ?? [];
        return theirs.slice(0, -1).reverse()[depth] === folder;
      });
      if (!clashes) return { name, folder };
    }
    return { name, folder: folders.length > 0 ? segments.slice(0, -1).join("/") : undefined };
  });
}
