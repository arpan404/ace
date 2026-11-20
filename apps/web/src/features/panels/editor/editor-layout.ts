import {
  focusedGroup,
  groupsOf,
  type EditorLayout,
  type EditorTab,
  type GroupNode,
  type SplitNode,
} from "@ace/ui-core/editor-workbench";

export { editorKind, editorLayoutOf, groupIds, openInLayout } from "@/lib/workspace/index.ts";

/*
 * The editor's layout beyond opening a file (`lib/workspace/editor-tab.ts`): following renames, the
 * open editors in MRU order, and the paths open anywhere. Pure.
 */

/** A checkout entry renamed (or moved) in this window: `from` and `to` are checkout paths. */
export interface EditorRename {
  from: string;
  to: string;
  /** A folder: every open path inside it follows. */
  folder: boolean;
}

/** Where `path` is after `rename`, or undefined when the rename doesn't touch it. */
export function renamedPath(path: string, rename: EditorRename): string | undefined {
  if (path === rename.from) return rename.to;
  if (rename.folder && path.startsWith(`${rename.from}/`))
    return `${rename.to}${path.slice(rename.from.length)}`;
  return undefined;
}

/**
 * Every open editor of a renamed (or moved) file shows its new path, keeping its place, view
 * state and pin; the closed list and the explorer's open folders follow too. A rename onto a
 * path the group already shows keeps the one tab.
 */
export function renameInLayout(layout: EditorLayout, rename: EditorRename): EditorLayout {
  const follow = (path: string) => renamedPath(path, rename) ?? path;
  let changed = false;
  const group = (node: GroupNode): GroupNode => {
    if (!node.tabs.some((tab) => follow(tab.path) !== tab.path)) return node;
    changed = true;
    const seen = new Set<string>();
    const tabs: EditorTab[] = [];
    for (const tab of node.tabs) {
      const path = follow(tab.path);
      if (seen.has(path)) continue;
      seen.add(path);
      tabs.push(path === tab.path ? tab : { ...tab, path });
    }
    const mru = [...new Set(node.mru.map(follow))];
    return {
      ...node,
      tabs,
      mru,
      active: node.active === undefined ? undefined : follow(node.active),
    };
  };
  const walk = (node: SplitNode): SplitNode =>
    node.kind === "group" ? group(node) : { ...node, children: node.children.map(walk) };
  const root = walk(layout.root);
  const expanded = layout.explorer.expanded.map(follow);
  const folders = expanded.some((path, index) => path !== layout.explorer.expanded[index]);
  const closed = layout.closed.map((each) =>
    follow(each.tab.path) === each.tab.path
      ? each
      : { ...each, tab: { ...each.tab, path: follow(each.tab.path) } },
  );
  const closedMoved = closed.some((each, index) => each !== layout.closed[index]);
  if (!changed && !folders && !closedMoved) return layout;
  return {
    ...layout,
    root,
    explorer: folders ? { ...layout.explorer, expanded } : layout.explorer,
    closed,
  };
}

/** Open editors, most recently used first: the focused group's MRU, then the other groups'. */
export function openEditorsMru(layout: EditorLayout): readonly string[] {
  const focused = focusedGroup(layout);
  const groups = [focused, ...groupsOf(layout).filter((group) => group.id !== focused.id)];
  const paths = new Set<string>();
  for (const group of groups) {
    for (const path of group.mru) paths.add(path);
    for (const tab of group.tabs) paths.add(tab.path);
  }
  return [...paths];
}

/** Every path open in any group, once. */
export function openPaths(layout: EditorLayout): readonly string[] {
  return [...new Set(groupsOf(layout).flatMap((group) => group.tabs.map((tab) => tab.path)))];
}
