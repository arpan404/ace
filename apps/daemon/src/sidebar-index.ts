import type { SQLOutputValue } from "node:sqlite";
import { OrderedTree } from "./ordered-tree.ts";

/** One thread's sidebar facts, exactly as the sidebar SQL expressions evaluate them. */
export interface SidebarFacts {
  id: string;
  revision: number;
  workspace: SQLOutputValue;
  deleted: boolean;
  archived: boolean;
  /** The settled expression: paged with history, live above it, or NULL (shown in neither). */
  settled: boolean | null;
  /** Counted in its project's total: not an unsent draft. */
  counted: boolean;
  activity: SQLOutputValue;
  archivedAt: SQLOutputValue;
}
export interface SidebarScope {
  project?: string | undefined;
  archived?: boolean | undefined;
}
export interface SidebarWindowIds {
  /** Live threads, all of them, newest first. Empty for the archive. */
  active: string[];
  /** The first `limit` paged threads, newest first. */
  page: string[];
  more: boolean;
  total: number;
  counts: { id: string; threads: number }[];
}

/**
 * Every thread's sidebar membership and order, kept sorted as rows change, so a window
 * update costs the changed rows plus the window it returns, never a scan of all threads.
 * Orders and groups the way SQLite does: `ORDER BY key DESC, id ASC` over raw values.
 */
export class SidebarIndex {
  private readonly facts = new Map<string, SidebarFacts>();
  private readonly lists = {
    paged: new Lists("activity"),
    active: new Lists("activity"),
    archived: new Lists("archivedAt"),
  };
  /** Counted threads per workspace, for live (index 0) and archived (index 1) scopes. */
  private readonly counts = [new Counts(), new Counts()] as const;

  revision(id: string): number | undefined {
    return this.facts.get(id)?.revision;
  }
  /** Replace everything with these threads, ids unique: one sort per list, not n inserts. */
  load(all: Iterable<SidebarFacts>): void {
    this.clear();
    const grouped = new Map<SortedFacts, SidebarFacts[]>();
    for (const facts of all) {
      if (this.facts.has(facts.id)) throw new Error("Sidebar facts repeat a thread");
      this.facts.set(facts.id, facts);
      this.count(facts, 1);
      this.listsOf(facts, (list) => {
        const items = grouped.get(list);
        if (items) items.push(facts);
        else grouped.set(list, [facts]);
      });
    }
    for (const [list, items] of grouped) list.tree.load(items.toSorted(list.compare));
  }
  /** Insert or replace one thread's facts. */
  put(facts: SidebarFacts): void {
    this.remove(facts.id);
    this.facts.set(facts.id, facts);
    this.listsOf(facts, (list) => list.tree.insert(facts));
    this.count(facts, 1);
  }
  remove(id: string): void {
    const facts = this.facts.get(id);
    if (!facts) return;
    this.facts.delete(id);
    this.listsOf(facts, (list) => list.tree.remove(facts));
    this.count(facts, -1);
  }
  clear(): void {
    this.facts.clear();
    for (const lists of Object.values(this.lists)) lists.clear();
    this.counts[0].clear();
    this.counts[1].clear();
  }
  window(scope: SidebarScope, limit: number): SidebarWindowIds {
    const archived = scope.archived === true;
    const pick = (lists: Lists) =>
      scope.project === undefined ? lists.all : lists.projects.get(scope.project);
    const paged = pick(archived ? this.lists.archived : this.lists.paged);
    const active = archived ? undefined : pick(this.lists.active);
    return {
      active: active?.tree.first(Infinity).map((facts) => facts.id) ?? [],
      page: paged?.tree.first(limit).map((facts) => facts.id) ?? [],
      more: (paged?.tree.size ?? 0) > limit,
      total: paged?.tree.size ?? 0,
      counts: this.counts[archived ? 1 : 0]
        .values()
        .toSorted((a, b) => compareSql(a.workspace, b.workspace))
        .map((count) => ({ id: String(count.workspace), threads: count.threads })),
    };
  }
  /** The lists a thread belongs to: its kind, in all projects and in its own project. */
  private listsOf(facts: SidebarFacts, visit: (list: SortedFacts) => void): void {
    if (facts.deleted) return;
    const lists = facts.archived
      ? this.lists.archived
      : facts.settled === true
        ? this.lists.paged
        : facts.settled === false
          ? this.lists.active
          : undefined;
    if (!lists) return;
    visit(lists.all);
    // `workspace_id = ?` binds the project as text, so only a text workspace can match it.
    if (typeof facts.workspace === "string") visit(lists.project(facts.workspace));
  }
  private count(facts: SidebarFacts, delta: 1 | -1): void {
    if (!facts.deleted && facts.counted)
      this.counts[facts.archived ? 1 : 0].add(facts.workspace, delta);
  }
}

/** One list's tree and its order: `ORDER BY key DESC, id ASC`. */
interface SortedFacts {
  tree: OrderedTree<SidebarFacts>;
  compare: (a: SidebarFacts, b: SidebarFacts) => number;
}
/** One kind of list, across all projects and per project. */
class Lists {
  all: SortedFacts;
  readonly projects = new Map<string, SortedFacts>();
  private readonly key: "activity" | "archivedAt";
  constructor(key: "activity" | "archivedAt") {
    this.key = key;
    this.all = this.create();
  }
  project(workspace: string): SortedFacts {
    let list = this.projects.get(workspace);
    if (!list) {
      list = this.create();
      this.projects.set(workspace, list);
    }
    return list;
  }
  clear(): void {
    this.all = this.create();
    this.projects.clear();
  }
  private create(): SortedFacts {
    const key = this.key;
    const compare = (a: SidebarFacts, b: SidebarFacts) =>
      compareSql(b[key], a[key]) || compareSql(a.id, b.id);
    return { tree: new OrderedTree(compare), compare };
  }
}

interface Count {
  workspace: SQLOutputValue;
  threads: number;
}
/** Per-workspace counts, grouped as `GROUP BY workspace_id` groups raw values. */
class Counts {
  // Map keys compare like SQLite groups here: text and numbers never match each other.
  private readonly plain = new Map<SQLOutputValue, Count>();
  private readonly blobs = new Map<string, Count>();
  add(workspace: SQLOutputValue, delta: 1 | -1): void {
    const map: Map<SQLOutputValue, Count> =
      workspace instanceof Uint8Array ? this.blobs : this.plain;
    const key =
      workspace instanceof Uint8Array ? Buffer.from(workspace).toString("hex") : workspace;
    const count = map.get(key) ?? { workspace, threads: 0 };
    count.threads += delta;
    if (count.threads > 0) map.set(key, count);
    else map.delete(key);
  }
  values(): Count[] {
    return [...this.plain.values(), ...this.blobs.values()];
  }
  clear(): void {
    this.plain.clear();
    this.blobs.clear();
  }
}

/** SQLite's default ordering: NULL, then numbers by value, then text by code point, then blobs. */
export function compareSql(a: SQLOutputValue, b: SQLOutputValue): number {
  const rank = storageClass(a) - storageClass(b);
  if (rank !== 0) return rank;
  if (typeof a === "string" && typeof b === "string") return compareText(a, b);
  if (a instanceof Uint8Array && b instanceof Uint8Array) return Buffer.compare(a, b);
  if (a === null || b === null) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}
function storageClass(value: SQLOutputValue): number {
  if (value === null) return 0;
  if (typeof value === "number" || typeof value === "bigint") return 1;
  if (typeof value === "string") return 2;
  return 3;
}
/** BINARY collation compares UTF-8 bytes, which is code point order, not UTF-16 unit order. */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return codePointRank(x) - codePointRank(y);
  }
  return a.length - b.length;
}
/** Surrogates encode code points above U+FFFF, so they sort after U+E000..U+FFFF. */
function codePointRank(unit: number): number {
  if (unit >= 0xe000) return unit - 0x800;
  if (unit >= 0xd800) return unit + 0x2000;
  return unit;
}
