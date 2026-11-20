import * as z from "zod/mini";
import { normalize, normalSizes, removeTab, updateGroup, walkGroups } from "./nodes.ts";
import { emptyGroup, groupsOf } from "./tree.ts";
import {
  defaultExplorer,
  limits,
  type ClosedEditor,
  type EditorLayout,
  type EditorTab,
  type ExplorerState,
  type GroupNode,
  type SplitNode,
  type ViewState,
} from "./types.ts";

/*
 * The stored layout (spec 52) and its lenient reading. A layout comes from local storage, which
 * an older or newer build may have written or a person may have edited, so every part is checked
 * and a bad part drops alone: a bad tab leaves its group, a bad group leaves its split, and a
 * layout with no usable group becomes one empty group. Fields this build doesn't know are kept.
 */

const text = z.string().check(z.minLength(1), z.maxLength(4096));
const count = z.number().check(z.int(), z.gte(0));

const View = z.looseObject({
  anchor: z.optional(z.object({ line: count, offset: z.number() })),
  selections: z.optional(z.array(z.object({ anchor: count, head: count }))),
  folds: z.optional(z.array(count)),
});

const Tab = z.looseObject({
  path: text,
  preview: z.catch(z.boolean(), false),
  pinned: z.catch(z.boolean(), false),
  view: z.optional(z.unknown()),
});

const Group = z.looseObject({
  kind: z.literal("group"),
  id: z.string().check(z.minLength(1), z.maxLength(256)),
  tabs: z.catch(z.array(z.unknown()), []),
  active: z.optional(z.unknown()),
  mru: z.catch(z.array(z.unknown()), []),
});

const Split = z.looseObject({
  kind: z.literal("split"),
  direction: z.enum(["row", "column"]),
  sizes: z.catch(z.array(z.unknown()), []),
  children: z.array(z.unknown()),
});

const Explorer = z.looseObject({
  open: z.catch(z.boolean(), defaultExplorer.open),
  width: z.catch(z.number().check(z.gte(200), z.lte(360)), defaultExplorer.width),
  side: z.catch(z.enum(["files", "search"]), defaultExplorer.side),
  expanded: z.catch(z.array(z.string()), []),
  scroll: z.catch(z.number().check(z.gte(0), z.lte(10_000_000)), 0),
  query: z.catch(z.string().check(z.maxLength(4096)), ""),
  openEditors: z.catch(z.boolean(), defaultExplorer.openEditors),
});

const Closed = z.looseObject({ group: text, index: z.catch(count, 0), tab: z.unknown() });

const Layout = z.looseObject({
  root: z.unknown(),
  focused: z.optional(z.unknown()),
  explorer: z.optional(z.unknown()),
  closed: z.catch(z.array(z.unknown()), []),
});

/** Splits nest no deeper than this; anything deeper is not a layout a person made. */
const maxDepth = 16;

function parseTab(raw: unknown): EditorTab | undefined {
  const parsed = Tab.safeParse(raw);
  if (!parsed.success) return undefined;
  const { view, ...tab } = parsed.data;
  const viewState: ViewState | undefined =
    view === undefined ? undefined : View.safeParse(view).data;
  return viewState ? { ...tab, view: viewState } : tab;
}

interface Reading {
  ids: Set<string>;
}

function parseGroup(raw: unknown, reading: Reading): GroupNode | undefined {
  const parsed = Group.safeParse(raw);
  if (!parsed.success) return undefined;
  const group = parsed.data;
  if (reading.ids.has(group.id) || reading.ids.size >= limits.groups) return undefined;
  reading.ids.add(group.id);
  const seen = new Set<string>();
  const read: EditorTab[] = [];
  for (const each of group.tabs) {
    const tab = parseTab(each);
    if (!tab || seen.has(tab.path)) continue;
    seen.add(tab.path);
    read.push(tab);
  }
  // Pinned tabs first in their order; one preview at most, and never a pinned one.
  let previewSeen = false;
  const tabs = [...read.filter((tab) => tab.pinned), ...read.filter((tab) => !tab.pinned)].map(
    (tab) => {
      if (!tab.preview) return tab;
      if (tab.pinned || previewSeen) return { ...tab, preview: false };
      previewSeen = true;
      return tab;
    },
  );
  const mru = [
    ...new Set(
      group.mru.filter((path): path is string => typeof path === "string" && seen.has(path)),
    ),
  ];
  for (const tab of tabs) if (!mru.includes(tab.path)) mru.push(tab.path);
  const active = typeof group.active === "string" && seen.has(group.active) ? group.active : mru[0];
  return { ...group, kind: "group", tabs, mru, active };
}

function parseNode(raw: unknown, reading: Reading, depth: number): SplitNode | undefined {
  if (depth > maxDepth) return undefined;
  const group = parseGroup(raw, reading);
  if (group) return group;
  const parsed = Split.safeParse(raw);
  if (!parsed.success) return undefined;
  const split = parsed.data;
  const children: SplitNode[] = [];
  const sizes: unknown[] = [];
  split.children.forEach((each, index) => {
    const child = parseNode(each, reading, depth + 1);
    if (!child) return;
    children.push(child);
    sizes.push(split.sizes.length === split.children.length ? split.sizes[index] : undefined);
  });
  return normalize({
    ...split,
    kind: "split",
    direction: split.direction,
    sizes: normalSizes(sizes, children.length),
    children,
  });
}

function parseExplorer(raw: unknown): ExplorerState {
  const parsed = Explorer.safeParse(raw);
  return parsed.success ? parsed.data : defaultExplorer;
}

function parseClosed(raw: readonly unknown[]): ClosedEditor[] {
  const closed: ClosedEditor[] = [];
  for (const each of raw) {
    if (closed.length >= limits.closed) break;
    const parsed = Closed.safeParse(each);
    const tab = parsed.success ? parseTab(parsed.data.tab) : undefined;
    if (parsed.success && tab) closed.push({ ...parsed.data, tab });
  }
  return closed;
}

/**
 * Read a stored layout leniently: bad parts drop, unknown fields stay, and anything unusable
 * becomes one empty group with this id.
 */
export function parseLayout(raw: unknown, fallbackGroupId: string): EditorLayout {
  const parsed = Layout.safeParse(raw);
  if (!parsed.success) return parseLayout({}, fallbackGroupId);
  const { root: rawRoot, focused: rawFocused, explorer, closed, ...extra } = parsed.data;
  const root = parseNode(rawRoot, { ids: new Set() }, 0) ?? emptyGroup(fallbackGroupId);
  const groups = walkGroups(root);
  const focused =
    typeof rawFocused === "string" && groups.some((group) => group.id === rawFocused)
      ? rawFocused
      : (groups[0]?.id ?? fallbackGroupId);
  return {
    ...extra,
    root,
    focused,
    explorer: parseExplorer(explorer),
    closed: parseClosed(closed),
  };
}

/**
 * The layout as stored (spec 52): past the tab cap, the least recently used tabs that are
 * neither pinned, unsaved nor showing drop until the cap is met.
 */
export function storedLayout(layout: EditorLayout, unsaved: ReadonlySet<string>): EditorLayout {
  const groups = groupsOf(layout);
  const total = groups.reduce((sum, group) => sum + group.tabs.length, 0);
  if (total <= limits.storedTabs) return layout;
  const candidates = groups.flatMap((group, order) =>
    group.tabs
      .filter((tab) => !tab.pinned && !unsaved.has(tab.path) && tab.path !== group.active)
      .map((tab) => {
        const used = group.mru.indexOf(tab.path);
        return { group: group.id, path: tab.path, age: used < 0 ? group.tabs.length : used, order };
      }),
  );
  candidates.sort((a, b) => b.age - a.age || b.order - a.order);
  let next = layout;
  for (const drop of candidates.slice(0, total - limits.storedTabs)) {
    next = updateGroup(next, drop.group, (group) => removeTab(group, drop.path));
  }
  return next;
}
