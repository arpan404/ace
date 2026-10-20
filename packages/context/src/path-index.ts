import { requireContext } from "./errors.ts";
import {
  characterMask,
  containsMask,
  entryBytes,
  scoreSubsequence,
  type CharacterMask,
} from "./path-match.ts";

function parent(path: string): string {
  return path.slice(0, path.slice(0, -1).lastIndexOf("/") + 1);
}
function folders(path: string): string[] {
  const result: string[] = [];
  for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1))
    result.push(path.slice(0, at + 1));
  return result;
}
interface Entry extends CharacterMask {
  readonly lower: string;
}
/**
 * Bounded fuzzy index with directory reference counts and O(subtree) folder
 * enumeration. Each entry keeps character-class masks instead of per-character
 * postings, so retained memory stays proportional to path bytes.
 */
export class PathIndex {
  private files = new Set<string>();
  private entries = new Map<string, Entry>();
  private directories = new Map<string, number>();
  private children = new Map<string, Set<string>>();
  private cap: number;
  private bytes = 0;
  constructor(cap = 100_000) {
    requireContext(
      Number.isInteger(cap) && cap > 0 && cap <= 1_000_000,
      "invalid_request",
      "Invalid path index cap",
    );
    this.cap = cap;
  }
  /** Conservative retained-heap estimate, maintained per changed entry. */
  get estimatedBytes(): number {
    return this.bytes;
  }
  private add(path: string): void {
    const lower = path.toLowerCase();
    const mask = characterMask(lower);
    // Flat records: one allocation per path.
    this.entries.set(path, { lower, letters: mask.letters, others: mask.others });
    this.bytes += entryBytes(path);
    const owner = parent(path);
    let children = this.children.get(owner);
    if (!children) {
      children = new Set();
      this.children.set(owner, children);
    }
    children.add(path);
  }
  private remove(path: string): void {
    if (!this.entries.delete(path)) return;
    this.bytes -= entryBytes(path);
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
  /** Validate combined capacity before publishing any part of a subtree. */
  replaceSubtree(folder: string, replacement: PathIndex): void {
    const before = new Set(this.under(folder));
    const next = new Set(replacement.under(folder));
    const removed = [...before].filter((path) => !next.has(path));
    const added = [...next].filter((path) => !before.has(path));
    const references = new Map<string, number>();
    for (const path of removed)
      for (const ancestor of folders(path))
        references.set(ancestor, (references.get(ancestor) ?? 0) - 1);
    for (const path of added)
      for (const ancestor of folders(path))
        references.set(ancestor, (references.get(ancestor) ?? 0) + 1);
    let size = this.entries.size + added.length - removed.length;
    for (const [ancestor, change] of references) {
      const previous = this.directories.get(ancestor) ?? 0;
      const remaining = previous + change;
      if (!previous && remaining) size++;
      else if (previous && !remaining) size--;
    }
    requireContext(
      size <= this.cap && added.every((path) => path.length <= 1024),
      "quota",
      "Workspace index limit exceeded",
    );
    // All removals precede additions, so intermediate size cannot exceed the
    // validated final size. Work stays proportional to the affected subtree.
    for (const path of removed) this.update(path, false);
    for (const path of added) this.update(path, true);
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
    const required = characterMask(needle);
    const best: { path: string; score: number }[] = [];
    for (const [path, entry] of this.entries) {
      // The mask is a necessary condition; the subsequence scan decides.
      if (!containsMask(entry, required)) continue;
      const score = scoreSubsequence(entry.lower, needle);
      if (score < 0) continue;
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
