import { TREE_CAP, WorkspaceError, type Change, type Entry } from "./types.ts";

function parent(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}
/** An index of immediate children makes subtree deletion proportional to its size. */
export class VisibleTree {
  private readonly entries = new Map<string, Entry>();
  private readonly children = new Map<string, Set<string>>();
  constructor(entries: Iterable<Entry>) {
    for (const entry of entries) this.add(entry);
  }
  private add(entry: Entry): void {
    this.entries.set(entry.path, entry);
    const dir = parent(entry.path);
    let children = this.children.get(dir);
    if (!children) {
      children = new Set();
      this.children.set(dir, children);
    }
    children.add(entry.path);
  }
  *under(path: string): Generator<Entry> {
    const entry = this.entries.get(path);
    if (entry) yield entry;
    for (const child of this.children.get(path) ?? []) yield* this.under(child);
  }
  get(path: string): Entry | undefined {
    return this.entries.get(path);
  }
  values(): IterableIterator<Entry> {
    return this.entries.values();
  }
  apply(updates: Map<string, Entry>, removed: Set<string>, forced: Set<string>): Change[] {
    const affected = new Map<string, Entry | undefined>();
    for (const path of new Set([...removed, ...updates.keys()]))
      affected.set(path, this.entries.get(path));
    let size = this.entries.size;
    for (const [path, before] of affected) {
      if (before) size--;
      if (updates.has(path) || (!removed.has(path) && before)) size++;
    }
    if (size > TREE_CAP)
      throw new WorkspaceError("LIMIT_EXCEEDED", "Workspace watch exceeds 100,000 entries");
    for (const path of removed) {
      this.entries.delete(path);
      this.children.get(parent(path))?.delete(path);
      this.children.delete(path);
    }
    for (const entry of updates.values()) this.add(entry);
    const changes: Change[] = [];
    for (const [path, before] of affected) {
      const after = this.entries.get(path);
      if (!after && before) changes.push({ path, kind: "deleted" });
      else if (after && !before) changes.push({ path, kind: "created" });
      else if (
        after &&
        before &&
        (after.size !== before.size ||
          after.mtime !== before.mtime ||
          after.type !== before.type ||
          forced.has(path))
      )
        changes.push({ path, kind: "changed" });
    }
    return changes.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}
