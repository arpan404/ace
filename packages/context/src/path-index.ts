import { requireContext } from "./errors.ts";

/** Bounded fuzzy subsequence index. No filesystem reads during completion. */
export class PathIndex {
  private paths = new Map<string, string>();
  private postings = new Map<string, Set<string>>();
  private cap: number;
  constructor(cap = 100_000) {
    this.cap = cap;
  }
  update(path: string, present: boolean): void {
    const previous = this.paths.get(path);
    if (previous !== undefined) {
      for (const char of new Set(previous)) {
        const bucket = this.postings.get(char);
        bucket?.delete(path);
        if (!bucket?.size) this.postings.delete(char);
      }
      this.paths.delete(path);
    }
    if (!present) return;
    requireContext(
      path.length <= 1024 && this.paths.size < this.cap,
      "quota",
      "Workspace index limit exceeded",
    );
    const lower = path.toLowerCase();
    this.paths.set(path, lower);
    for (const char of new Set(lower)) {
      let bucket = this.postings.get(char);
      if (!bucket) {
        bucket = new Set();
        this.postings.set(char, bucket);
      }
      bucket.add(path);
    }
  }
  *under(folder: string): Iterable<string> {
    const prefix = folder === "." ? "" : `${folder}/`;
    for (const path of this.paths.keys()) if (path.startsWith(prefix)) yield path;
  }
  complete(query: string, limit = 20): string[] {
    requireContext(
      query.length <= 128 && Number.isInteger(limit) && limit > 0 && limit <= 50,
      "invalid_request",
      "Invalid completion limits",
    );
    const needle = query.toLowerCase();
    let candidates: Iterable<string> = this.paths.keys();
    let smallest: Set<string> | undefined;
    for (const char of new Set(needle)) {
      const bucket = this.postings.get(char);
      if (!bucket?.size) return [];
      if (!smallest || bucket.size < smallest.size) smallest = bucket;
    }
    if (smallest) candidates = smallest;
    const best: { path: string; score: number }[] = [];
    for (const path of candidates) {
      const lower = this.paths.get(path);
      if (lower === undefined) continue;
      let at = 0;
      let score = lower.length;
      let matched = true;
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
      const candidate = { path, score };
      let position = best.findIndex(
        (item) => score < item.score || (score === item.score && path < item.path),
      );
      if (position < 0) position = best.length;
      if (position < limit) best.splice(position, 0, candidate);
      if (best.length > limit) best.pop();
      if (!needle && best.length === limit) break;
    }
    return best.map((item) => item.path);
  }
}
