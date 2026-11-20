import {
  defaultExplorer,
  groupsOf,
  type EditorLayout,
  type GroupNode,
  type SplitNode,
} from "./index.ts";

/*
 * Test shorthand. A tab is written as its path with marks: `~a.ts` a preview, `^a.ts` pinned.
 * `strip` reads a group back in the same shorthand, so tests compare strips as short arrays.
 */

export function group(id: string, tabs: readonly string[], active?: string): GroupNode {
  const parsed = tabs.map((mark) => ({
    path: mark.replace(/^[~^]/, ""),
    preview: mark.startsWith("~"),
    pinned: mark.startsWith("^"),
  }));
  const paths = parsed.map((tab) => tab.path);
  const shown = active ?? paths[0];
  return {
    kind: "group",
    id,
    tabs: parsed,
    active: shown,
    mru: shown === undefined ? [] : [shown, ...paths.filter((path) => path !== shown)],
  };
}

export function layoutOf(root: SplitNode, focused?: string): EditorLayout {
  return {
    root,
    focused:
      focused ??
      groupsOf({ root, focused: "", explorer: defaultExplorer, closed: [] })[0]?.id ??
      "",
    explorer: defaultExplorer,
    closed: [],
  };
}

export const row = (children: SplitNode[], sizes?: number[]): SplitNode => ({
  kind: "split",
  direction: "row",
  sizes: sizes ?? children.map(() => 1 / children.length),
  children,
});

export const column = (children: SplitNode[], sizes?: number[]): SplitNode => ({
  kind: "split",
  direction: "column",
  sizes: sizes ?? children.map(() => 1 / children.length),
  children,
});

const marked = (node: GroupNode) =>
  node.tabs.map((tab) => `${tab.pinned ? "^" : ""}${tab.preview ? "~" : ""}${tab.path}`);

export function strip(layout: EditorLayout, id: string): string[] | undefined {
  const found = groupsOf(layout).find((each) => each.id === id);
  return found && marked(found);
}

/** Every group's strip in reading order, keyed by id. */
export function strips(layout: EditorLayout): Record<string, string[]> {
  return Object.fromEntries(groupsOf(layout).map((each) => [each.id, marked(each)]));
}

/** A deterministic group id source: n1, n2, … */
export function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `n${next}`;
  };
}
