import type { SQLOutputValue } from "node:sqlite";

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
  private readonly lists = new Map<string, SortedFacts>();
  /** Counted threads per workspace, for live (index 0) and archived (index 1) scopes. */
  private readonly counts = [new Map<string, Count>(), new Map<string, Count>()] as const;

  revision(id: string): number | undefined {
    return this.facts.get(id)?.revision;
  }
  /** Insert or replace one thread's facts. */
  put(facts: SidebarFacts): void {
    this.remove(facts.id);
    this.facts.set(facts.id, facts);
    for (const key of listKeys(facts)) this.list(key, facts).insert(facts);
    if (!facts.deleted && facts.counted) {
      const counts = this.counts[facts.archived ? 1 : 0];
      const key = valueKey(facts.workspace);
      const count = counts.get(key);
      if (count) count.threads++;
      else counts.set(key, { workspace: facts.workspace, threads: 1 });
    }
  }
  remove(id: string): void {
    const facts = this.facts.get(id);
    if (!facts) return;
    this.facts.delete(id);
    for (const key of listKeys(facts)) this.lists.get(key)?.remove(facts);
    if (!facts.deleted && facts.counted) {
      const counts = this.counts[facts.archived ? 1 : 0];
      const key = valueKey(facts.workspace);
      const count = counts.get(key);
      if (count && --count.threads === 0) counts.delete(key);
    }
  }
  clear(): void {
    this.facts.clear();
    this.lists.clear();
    this.counts[0].clear();
    this.counts[1].clear();
  }
  window(scope: SidebarScope, limit: number): SidebarWindowIds {
    const archived = scope.archived === true;
    const project = scope.project === undefined ? "*" : projectKey(scope.project);
    const paged = this.lists.get(`${archived ? "archived" : "paged"}:${project}`);
    const active = archived ? undefined : this.lists.get(`active:${project}`);
    return {
      active: active?.ids(Infinity) ?? [],
      page: paged?.ids(limit) ?? [],
      more: (paged?.size ?? 0) > limit,
      total: paged?.size ?? 0,
      counts: [...this.counts[archived ? 1 : 0].values()]
        .toSorted((a, b) => compareSql(a.workspace, b.workspace))
        .map((count) => ({ id: String(count.workspace), threads: count.threads })),
    };
  }
  private list(key: string, facts: SidebarFacts): SortedFacts {
    let list = this.lists.get(key);
    if (!list) {
      list = new SortedFacts(facts.archived ? "archivedAt" : "activity");
      this.lists.set(key, list);
    }
    return list;
  }
}

interface Count {
  workspace: SQLOutputValue;
  threads: number;
}

/** The lists a thread belongs to: its kind, in all projects and in its own project. */
function listKeys(facts: SidebarFacts): string[] {
  if (facts.deleted) return [];
  const kind = facts.archived
    ? "archived"
    : facts.settled === true
      ? "paged"
      : facts.settled === false
        ? "active"
        : undefined;
  if (!kind) return [];
  // `workspace_id = ?` binds the project as text, so only a text workspace can match it.
  return typeof facts.workspace === "string"
    ? [`${kind}:*`, `${kind}:${projectKey(facts.workspace)}`]
    : [`${kind}:*`];
}
function projectKey(project: string): string {
  return `=${project}`;
}
function valueKey(value: SQLOutputValue): string {
  if (value instanceof Uint8Array) return `b:${Buffer.from(value).toString("hex")}`;
  return `${typeof value === "string" ? "s" : value === null ? "n" : "#"}:${String(value)}`;
}

class SortedFacts {
  private readonly items: SidebarFacts[] = [];
  private readonly key: "activity" | "archivedAt";
  constructor(key: "activity" | "archivedAt") {
    this.key = key;
  }
  get size(): number {
    return this.items.length;
  }
  insert(facts: SidebarFacts): void {
    this.items.splice(this.position(facts), 0, facts);
  }
  remove(facts: SidebarFacts): void {
    const at = this.position(facts);
    if (this.items[at]?.id === facts.id) this.items.splice(at, 1);
  }
  ids(limit: number): string[] {
    const ids: string[] = [];
    for (const facts of this.items) {
      if (ids.length >= limit) break;
      ids.push(facts.id);
    }
    return ids;
  }
  /** First index whose item does not sort before `facts`. */
  private position(facts: SidebarFacts): number {
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const item = this.items[middle];
      if (item && this.before(item, facts)) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  private before(a: SidebarFacts, b: SidebarFacts): boolean {
    const order = compareSql(b[this.key], a[this.key]);
    return order < 0 || (order === 0 && compareSql(a.id, b.id) < 0);
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
