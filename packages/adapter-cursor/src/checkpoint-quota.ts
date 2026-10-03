import { lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { checkCheckpointBudget } from "./checkpoints.ts";

/** One conservative aggregate ledger for all writers in a thread host.
 * Reservations are serialized before I/O. SDK allocation overhead is reserved,
 * released against only changed native files, so unrelated retained files are not scanned.
 */
export class CheckpointQuota {
  private initial: Promise<void> | undefined;
  private used = 0;
  private failed = false;
  private sizes = new Map<string, number>();
  private paths = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private pendingBytes = 0;
  constructor(root: string, maxBytes: number) {
    this.root = root;
    this.max = maxBytes;
  }
  private root: string;
  private max: number;
  journal<T>(growth: number, operation: () => Promise<T>): Promise<T> {
    return this.reserve(growth, operation, ["ace-boundary.ndjson"]);
  }
  run<T>(growth: number, operation: () => Promise<T>, agentId?: string): Promise<T> {
    const bases = [
      "index.db",
      "agents.ndjson",
      "runs.ndjson",
      "checkpoints.ndjson",
      "run_events.ndjson",
    ];
    if (agentId)
      bases.push(
        join("agents", `agent-${createHash("sha256").update(agentId).digest("hex")}`, "store.db"),
      );
    return this.reserve(growth, operation, bases);
  }
  private reserve<T>(growth: number, operation: () => Promise<T>, bases: string[]): Promise<T> {
    if (!Number.isSafeInteger(growth) || growth < 0 || growth > this.max)
      return Promise.reject(new Error("SDK checkpoint growth exceeds budget"));
    if (this.pending >= 32 || this.pendingBytes + growth > this.max * 2)
      return Promise.reject(new Error("SDK checkpoint reservation backlog exceeds budget"));
    this.pending++;
    this.pendingBytes += growth;
    const task = this.tail.then(async () => {
      if (this.failed) throw new Error("SDK checkpoint quota is fenced");
      this.initial ??= checkCheckpointBudget(this.root, this.max).then(
        ({ bytes, sizes, paths }) => {
          this.used = bytes;
          this.sizes = sizes;
          this.paths = paths;
        },
      );
      await this.initial;
      if (this.used + growth > this.max)
        throw new Error(
          "SDK aggregate checkpoint growth exceeds budget; previous checkpoint retained",
        );
      const potential = new Set<string>();
      for (const base of bases) {
        for (const suffix of base.endsWith(".db") ? ["", "-wal", "-shm"] : [""])
          potential.add(join(this.root, base + suffix));
        if (dirname(base) !== ".") {
          potential.add(join(this.root, "agents"));
          potential.add(join(this.root, dirname(base)));
        }
      }
      let extra = 0;
      for (const path of potential) if (!this.paths.has(path)) extra++;
      if (this.paths.size + extra > 128)
        throw new Error(
          "SDK aggregate checkpoint inventory exceeds budget; previous checkpoint retained",
        );
      for (const path of potential) this.paths.add(path);
      // The reservation remains charged on an I/O error. Never assume a failed
      // vendor write rolled back or reuse possibly allocated bytes after it.
      this.used += growth;
      let result: T;
      try {
        result = await operation();
      } catch (error) {
        this.failed = true;
        throw error;
      }
      this.used -= growth;
      for (const base of bases)
        for (const suffix of base.endsWith(".db") ? ["", "-wal", "-shm"] : [""]) {
          const path = join(this.root, base + suffix);
          let size = 0;
          try {
            const stat = await lstat(path);
            if (!stat.isFile() || stat.isSymbolicLink())
              throw new Error("Unsafe SDK checkpoint allocation");
            size = stat.size;
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
          }
          this.used += size - (this.sizes.get(path) ?? 0);
          if (size) this.sizes.set(path, size);
          else this.sizes.delete(path);
        }
      if (this.sizes.size > 128 || this.used > this.max) {
        this.failed = true;
        throw new Error("SDK allocation exceeded its reserved quota");
      }
      return result;
    });
    this.tail = task.then(
      () => {},
      () => {},
    );
    return task.finally(() => {
      this.pending--;
      this.pendingBytes -= growth;
    });
  }
}
