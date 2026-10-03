import { requireContext } from "./errors.ts";

function parent(path: string): string {
  return path.slice(0, path.slice(0, -1).lastIndexOf("/") + 1);
}
function folders(path: string): string[] {
  const result: string[] = [];
  for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1))
    result.push(path.slice(0, at + 1));
  return result;
}
/** Bounded fuzzy index with directory reference counts and O(subtree) folder enumeration. */
export class PathIndex {
  private files = new Set<string>();
  private entries = new Map<string, string>();
  private directories = new Map<string, number>();
  private children = new Map<string, Set<string>>();
  private postings = new Map<string, Set<string>>();
  private cap: number;
  constructor(cap = 100_000) {
    requireContext(
      Number.isInteger(cap) && cap > 0 && cap <= 1_000_000,
      "invalid_request",
      "Invalid path index cap",
    );
    this.cap = cap;
  }
  private add(path: string): void {
    const lower = path.toLowerCase();
    this.entries.set(path, lower);
    for (const char of new Set(lower)) {
      let bucket = this.postings.get(char);
      if (!bucket) {
        bucket = new Set();
        this.postings.set(char, bucket);
      }
      bucket.add(path);
    }
    const owner = parent(path);
    let children = this.children.get(owner);
    if (!children) {
      children = new Set();
      this.children.set(owner, children);
    }
    children.add(path);
  }
  private remove(path: string): void {
    const previous = this.entries.get(path);
    if (previous === undefined) return;
    for (const char of new Set(previous)) {
      const bucket = this.postings.get(char);
      bucket?.delete(path);
      if (!bucket?.size) this.postings.delete(char);
    }
    this.entries.delete(path);
    const owner = parent(path),
      children = this.children.get(owner);
    children?.delete(path);
    if (!children?.size) this.children.delete(owner);
  }
  update(path: string, present: boolean): void {
    if (this.files.has(path) === present) return;
    const ancestors = folders(path);
    if (present) {
      const missing = ancestors.filter((folder) => !this.directories.has(folder)).length;
      requireContext(
        path.length <= 1024 && this.entries.size + missing + 1 <= this.cap,
        "quota",
        "Workspace index limit exceeded",
      );
      for (const folder of ancestors) {
        const count = this.directories.get(folder) ?? 0;
        if (!count) this.add(folder);
        this.directories.set(folder, count + 1);
      }
      this.files.add(path);
      this.add(path);
    } else {
      this.files.delete(path);
      this.remove(path);
      for (const folder of ancestors) {
        const count = (this.directories.get(folder) ?? 1) - 1;
        if (count) this.directories.set(folder, count);
        else {
          this.directories.delete(folder);
          this.remove(folder);
        }
      }
    }
  }
  *under(folder: string): Iterable<string> {
    const prefix = folder === "." ? "" : `${folder}/`;
    const visit = function* (index: PathIndex, directory: string): Iterable<string> {
      for (const child of index.children.get(directory) ?? []) {
        if (child.endsWith("/")) yield* visit(index, child);
        else yield child;
      }
    };
    yield* visit(this, prefix);
  }
  complete(query: string, limit = 20): string[] {
    requireContext(
      query.length <= 128 && Number.isInteger(limit) && limit > 0 && limit <= 50,
      "invalid_request",
      "Invalid completion limits",
    );
    const needle = query.toLowerCase();
    let candidates: Iterable<string> = this.entries.keys(),
      smallest: Set<string> | undefined;
    for (const char of new Set(needle)) {
      const bucket = this.postings.get(char);
      if (!bucket?.size) return [];
      if (!smallest || bucket.size < smallest.size) smallest = bucket;
    }
    if (smallest) candidates = smallest;
    const best: { path: string; score: number }[] = [];
    for (const path of candidates) {
      const lower = this.entries.get(path);
      if (lower === undefined) continue;
      let at = 0,
        score = lower.length,
        matched = true;
      for (const char of needle) {
        const next = lower.indexOf(char, at);
        if (next < 0) {
          matched = false;
          break;
        }
        score += (next - at) * 4;
        at = next + 1;
      }
      if (!matched) continue;
      let position = best.findIndex(
        (item) => score < item.score || (score === item.score && path < item.path),
      );
      if (position < 0) position = best.length;
      if (position < limit) best.splice(position, 0, { path, score });
      if (best.length > limit) best.pop();
      if (!needle && best.length === limit) break;
    }
    return best.map((item) => item.path);
  }
}
