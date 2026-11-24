import type { SQLOutputValue } from "node:sqlite";
import { OrderedTree } from "./ordered-tree.ts";

/** One thread's sidebar facts, exactly as the sidebar SQL expressions evaluate them. */
export interface SidebarFacts {
  id: string;
  revision: number;
  workspace: SQLOutputValue;
  deleted: boolean;
  archived: boolean;
  /** In a chat's hidden project (ADR 0099): shown in every project's window, never left out. */
  chat: boolean;
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
  /** Carry every chat in a project's window: the client's own thread list asks for this. */
  withChats?: boolean | undefined;
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
      this.listsOf(facts)?.each(facts, 1, (list) => {
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
    this.listsOf(facts)?.each(facts, 1, (list) => list.tree.insert(facts));
    this.count(facts, 1);
  }
  remove(id: string): void {
    const facts = this.facts.get(id);
    if (!facts) return;
    this.facts.delete(id);
    this.listsOf(facts)?.each(facts, -1, (list) => list.tree.remove(facts));
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
    const withChats = scope.withChats === true;
    const paged = windowOf(
      archived ? this.lists.archived : this.lists.paged,
      scope.project,
      withChats,
    );
    const active = archived ? undefined : windowOf(this.lists.active, scope.project, withChats);
    return {
      active: active?.first(Infinity) ?? [],
      page: paged.first(limit),
      more: paged.size > limit,
      total: paged.size,
      counts: this.counts[archived ? 1 : 0]
        .values()
        .toSorted((a, b) => compareSql(a.workspace, b.workspace))
        .map((count) => ({ id: String(count.workspace), threads: count.threads })),
    };
  }
  /** The kind of list a thread belongs to: its tab, or none (a settled state of NULL). */
  private listsOf(facts: SidebarFacts): Lists | undefined {
    if (facts.deleted) return undefined;
    return facts.archived
      ? this.lists.archived
      : facts.settled === true
        ? this.lists.paged
        : facts.settled === false
          ? this.lists.active
          : undefined;
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
/** One kind of list, across all projects, per project and across every chat. */
class Lists {
  all: SortedFacts;
  chats: SortedFacts;
  readonly projects = new Map<string, SortedFacts>();
  /** Members in each chat workspace: the overlap a project's window has with `chats`. */
  private readonly chatMembers = new Map<string, number>();
  private readonly key: "activity" | "archivedAt";
  constructor(key: "activity" | "archivedAt") {
    this.key = key;
    this.all = this.create();
    this.chats = this.create();
  }
  /** Call `visit` with every list a fact belongs to, counting (`delta`) its chat workspace. */
  each(facts: SidebarFacts, delta: 1 | -1, visit: (list: SortedFacts) => void): void {
    visit(this.all);
    // `workspace_id = ?` binds the project as text, so only a text workspace can match it.
    if (typeof facts.workspace === "string") visit(this.project(facts.workspace));
    if (!facts.chat) return;
    visit(this.chats);
    if (typeof facts.workspace !== "string") return;
    const members = (this.chatMembers.get(facts.workspace) ?? 0) + delta;
    if (members > 0) this.chatMembers.set(facts.workspace, members);
    else this.chatMembers.delete(facts.workspace);
  }
  project(workspace: string): SortedFacts {
    let list = this.projects.get(workspace);
    if (!list) {
      list = this.create();
      this.projects.set(workspace, list);
    }
    return list;
  }
  /** The chats list's members in this workspace. */
  chatsIn(workspace: string): number {
    return this.chatMembers.get(workspace) ?? 0;
  }
  clear(): void {
    this.all = this.create();
    this.chats = this.create();
    this.projects.clear();
    this.chatMembers.clear();
  }
  private create(): SortedFacts {
    const key = this.key;
    const compare = (a: SidebarFacts, b: SidebarFacts) =>
      compareSql(b[key], a[key]) || compareSql(a.id, b.id);
    return { tree: new OrderedTree(compare), compare };
  }
}

/** A window's threads in one order: ids in that order, and how many it holds, each id once. */
interface WindowOf {
  first(limit: number): string[];
  size: number;
}
/**
 * One kind's window for a scope: every project, or one project's threads — with every chat's
 * too when `withChats` (ADR 0099), ordered together. A chat's own project appears once.
 */
function windowOf(lists: Lists, project: string | undefined, withChats: boolean): WindowOf {
  if (project === undefined)
    return { first: (limit) => ids(lists.all.tree.first(limit)), size: lists.all.tree.size };
  const own = lists.projects.get(project);
  if (!withChats) return { first: (limit) => firstOf(own, limit), size: own?.tree.size ?? 0 };
  return {
    first: (limit) => mergeFirst(own, lists.chats, limit),
    size: (own?.tree.size ?? 0) + lists.chats.tree.size - lists.chatsIn(project),
  };
}
const firstOf = (one: SortedFacts | undefined, limit: number) =>
  one ? ids(one.tree.first(limit)) : [];
const ids = (all: SidebarFacts[]) => all.map((facts) => facts.id);
/**
 * The first `limit` of two lists ordered as one, newest first, each id once. Reading `limit`
 * from each is enough: an item past its list's first `limit` has `limit` items before it, so it
 * cannot be in the first `limit` of the merge. Cost is proportional to the window, not history.
 */
function mergeFirst(one: SortedFacts | undefined, other: SortedFacts, limit: number): string[] {
  if (!one) return ids(other.tree.first(limit));
  const compare = one.compare;
  const left = one.tree.first(limit);
  const right = other.tree.first(limit);
  const seen = new Set<string>();
  const merged: string[] = [];
  let i = 0;
  let j = 0;
  while (merged.length < limit && (i < left.length || j < right.length)) {
    const a = left[i];
    const b = right[j];
    const next =
      a !== undefined && (b === undefined || compare(a, b) <= 0) ? left[i++] : right[j++];
    if (next === undefined) break;
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    merged.push(next.id);
  }
  return merged;
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
