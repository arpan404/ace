import { basename, dirname, join, relative, sep } from "node:path";
import type { Stats } from "node:fs";
import { CommandCatalog } from "./catalog.ts";
import { FileRecovery, statVersion } from "./recovery.ts";
import { parseMarkdown, parseOpenCodeConfig, parseCodexAgent } from "./parse.ts";
import type { CommandFileIo } from "./secure-io.ts";
import type { DirectoryReader } from "./posix.ts";
import { key, sourceId, type RegisteredRoot } from "./file-keys.ts";
interface Node {
  version: string;
  identity: string;
  children?: Map<string, number>;
  generation: number;
}
interface Job {
  kind: "inspect" | "scan" | "remove" | "replace";
  root: RegisteredRoot;
  path: string;
  depth: number;
}
interface Scan {
  reader: DirectoryReader;
  removing: Iterator<[string, number]> | undefined;
  generation: number;
  count: number;
  replaced: boolean;
  ended: boolean;
}
export interface DiscoveryMetrics {
  fileReads: number;
  readBytes: number;
  directoryEntries: number;
  metadataChecks: number;
  recoveryChecks: number;
}
/** One queue step performs one inspection, directory entry or removal. No recursive I/O. */
export class FileIndex {
  private readonly catalog: CommandCatalog;
  private readonly io: CommandFileIo;
  private readonly recovery: FileRecovery;
  private readonly roots: readonly RegisteredRoot[];
  private readonly nodes = new Map<string, Node>();
  private readonly sources = new Map<string, string>();
  private readonly references = new Map<string, number>();
  private readonly jobs = new Map<string, Job>();
  private readonly scans = new Map<string, Scan>();
  private readonly watch: (root: RegisteredRoot, path: string) => void;
  private readonly unwatch: (root: RegisteredRoot, path: string) => void;
  private readonly missing: (root: RegisteredRoot) => Promise<void>;
  private readonly counters: DiscoveryMetrics = {
    fileReads: 0,
    readBytes: 0,
    directoryEntries: 0,
    metadataChecks: 0,
    recoveryChecks: 0,
  };
  constructor(
    catalog: CommandCatalog,
    io: CommandFileIo,
    recovery: FileRecovery,
    roots: readonly RegisteredRoot[],
    ports: {
      watch(root: RegisteredRoot, path: string): void;
      unwatch(root: RegisteredRoot, path: string): void;
      missing(root: RegisteredRoot): Promise<void>;
    },
  ) {
    this.catalog = catalog;
    this.io = io;
    this.recovery = recovery;
    this.roots = roots;
    this.watch = ports.watch;
    this.unwatch = ports.unwatch;
    this.missing = ports.missing;
  }
  metrics(): DiscoveryMetrics {
    return { ...this.counters, recoveryChecks: this.recovery.checks };
  }
  get pending(): boolean {
    return this.jobs.size > 0;
  }
  enqueue(root: RegisteredRoot, path: string, depth: number): void {
    this.queue({ kind: "inspect", root, path, depth });
  }
  private queue(job: Job): void {
    const id = key(job.root, job.path);
    const previous = this.jobs.get(id);
    if (job.kind === "inspect" && (previous?.kind === "remove" || previous?.kind === "replace")) {
      this.jobs.set(id, { ...previous, kind: "replace" });
      return;
    }
    if (!this.jobs.has(id) && this.jobs.size >= 8192) {
      this.report(job.root, job.path, "Discovery queue limit exceeded");
      return;
    }
    this.jobs.set(id, job);
  }
  report(root: RegisteredRoot, path: string, message: string): void {
    const id = sourceId(root, path),
      slot = key(root, path);
    if (!this.sources.has(slot) && this.sources.size >= 2048) return;
    if (this.catalog.replaceSource(id, { commands: [], diagnostics: [{ source: id, message }] }))
      this.sources.set(slot, id);
  }
  private clearSource(slot: string): void {
    const id = this.sources.get(slot);
    if (id) this.catalog.removeSource(id);
    this.sources.delete(slot);
  }
  private async stopScan(slot: string): Promise<void> {
    const scan = this.scans.get(slot);
    this.scans.delete(slot);
    await scan?.reader.close();
  }
  private remember(job: Job, stat: Stats): Node | undefined {
    const slot = key(job.root, job.path);
    let node = this.nodes.get(slot);
    if (!node) {
      if (this.nodes.size >= 4096) {
        this.report(job.root, job.path, "Discovery node limit exceeded");
        return undefined;
      }
      node = { version: "", identity: "", generation: 0 };
      this.nodes.set(slot, node);
      this.references.set(job.path, (this.references.get(job.path) ?? 0) + 1);
      const parent = this.nodes.get(key(job.root, dirname(job.path)));
      parent?.children?.set(job.path, parent.generation);
    }
    node.version = statVersion(stat);
    node.identity = `${stat.dev}:${stat.ino}`;
    this.recovery.track(job.path, stat);
    return node;
  }
  private async remove(job: Job): Promise<void> {
    const slot = key(job.root, job.path),
      node = this.nodes.get(slot);
    await this.stopScan(slot);
    const child = node?.children?.keys().next().value;
    if (child !== undefined) {
      node?.children?.delete(child);
      this.queue({ ...job, path: child, depth: job.depth + 1, kind: "remove" });
      this.queue(job);
      return;
    }
    this.unwatch(job.root, job.path);
    this.clearSource(slot);
    if (!this.nodes.delete(slot)) {
      if (job.kind === "replace") this.enqueue(job.root, job.path, job.depth);
      return;
    }
    this.nodes.get(key(job.root, dirname(job.path)))?.children?.delete(job.path);
    const count = (this.references.get(job.path) ?? 1) - 1;
    if (count) this.references.set(job.path, count);
    else {
      this.references.delete(job.path);
      if (!this.roots.some((root) => root.path === job.path)) this.recovery.forget(job.path);
    }
    if (job.kind === "replace") this.enqueue(job.root, job.path, job.depth);
  }
  private async inspect(job: Job): Promise<void> {
    const { root, path, depth } = job,
      slot = key(root, path);
    this.counters.metadataChecks++;
    const stat = await this.io.stat(root, path);
    if (!stat) {
      if (path === root.path) {
        this.recovery.track(path, undefined);
        await this.missing(root);
      }
      this.queue({ ...job, kind: "remove" });
      return;
    }
    const previous = this.nodes.get(slot);
    if (previous?.version === statVersion(stat)) {
      // A duplicate invalidation may replace the queued scan continuation.
      if (this.scans.has(slot)) this.queue({ ...job, kind: "scan" });
      return;
    }
    if (stat.isDirectory()) {
      if (
        root.format === "opencode-config" ||
        depth > 8 ||
        (root.format === "codex" && !root.skill && path !== root.path)
      ) {
        this.queue({ ...job, kind: "remove" });
        return;
      }
      if (this.scans.size >= 32 && !this.scans.has(slot)) {
        this.queue(job);
        return;
      }
      const replaced = previous !== undefined && previous.identity !== `${stat.dev}:${stat.ino}`;
      const node = this.remember(job, stat);
      if (!node) return;
      node.children ??= new Map();
      node.generation++;
      await this.stopScan(slot);
      this.watch(root, path);
      try {
        const reader = await this.io.directory(root, path);
        this.scans.set(slot, {
          reader,
          removing: undefined,
          generation: node.generation,
          count: 0,
          replaced,
          ended: false,
        });
        this.queue({ ...job, kind: "scan" });
      } catch {
        node.version = "";
        this.recovery.track(path, undefined);
        this.report(root, path, "Cannot scan commands directory");
      }
      return;
    }
    if (
      !stat.isFile() ||
      (root.format !== "opencode-config" &&
        (!(root.format === "codex" && root.kind === "agent"
          ? path.endsWith(".toml")
          : path.endsWith(".md")) ||
          (root.skill && basename(path) !== "SKILL.md")))
    ) {
      this.queue({ ...job, kind: "remove" });
      return;
    }
    if (previous?.children) {
      this.queue({ ...job, kind: "replace" });
      return;
    }
    if (!this.sources.has(slot) && this.sources.size >= 2048) return;
    if (!this.remember(job, stat)) return;
    const id = sourceId(root, path),
      name = root.skill
        ? basename(dirname(path))
        : relative(root.path, path)
            .replace(/\.(?:md|toml)$/, "")
            .split(sep)
            .join(":");
    const ctx = {
      source: id,
      name,
      path,
      ...(root.kind === undefined ? {} : { kind: root.kind }),
      ...(root.plugin === undefined ? {} : { plugin: root.plugin }),
      scope: root.scope,
      ...(root.instance === undefined ? {} : { instance: root.instance }),
      ...(root.skill === undefined ? {} : { skill: root.skill }),
    };
    try {
      const read = await this.io.read(root, path);
      this.counters.fileReads++;
      this.counters.readBytes += read.bytes;
      this.remember(job, read.stat);
      const parsed =
        root.format === "codex" && root.kind === "agent"
          ? parseCodexAgent(read.text, ctx)
          : root.format === "opencode-config"
            ? parseOpenCodeConfig(read.text, ctx)
            : parseMarkdown(read.text, { ...ctx, format: root.format });
      if (!this.catalog.replaceSource(id, parsed)) {
        this.report(root, path, "Catalog admission limit exceeded");
        return;
      }
      this.sources.set(slot, id);
    } catch {
      const node = this.nodes.get(slot);
      if (node) node.version = "";
      this.recovery.track(path, undefined);
      this.report(root, path, "Cannot read command file within size limit");
    }
  }
  private async scan(job: Job): Promise<void> {
    const slot = key(job.root, job.path),
      scan = this.scans.get(slot);
    if (!scan) return;
    try {
      if (!scan.ended) {
        const name = await scan.reader.read();
        if (name !== undefined) this.counters.directoryEntries++;
        if (name === undefined) scan.ended = true;
        else if (name !== "." && name !== "..") {
          if (++scan.count > 2048) {
            await this.stopScan(slot);
            this.report(job.root, job.path, "Directory entry limit exceeded");
            return;
          }
          const path = join(job.path, name);
          const children = this.nodes.get(slot)?.children;
          if (children?.has(path)) children.set(path, scan.generation);
          // Surviving children already have metadata versions in the recovery ring.
          if (scan.replaced || !this.nodes.has(key(job.root, path)))
            this.enqueue(job.root, path, job.depth + 1);
        }
      } else {
        scan.removing ??= this.nodes.get(slot)?.children?.entries();
        const old = scan.removing?.next();
        if (old && !old.done) {
          const [path, generation] = old.value;
          if (generation !== scan.generation)
            this.queue({ ...job, path, depth: job.depth + 1, kind: "remove" });
        } else {
          await this.stopScan(slot);
          this.clearSource(slot);
          return;
        }
      }
      this.queue(job);
    } catch {
      await this.stopScan(slot);
      this.report(job.root, job.path, "Cannot scan commands directory");
    }
  }
  async step(): Promise<boolean> {
    for (let count = 0; count < 32; count++) {
      const next = this.jobs.entries().next().value;
      if (!next) break;
      const [slot, job] = next;
      this.jobs.delete(slot);
      if (job.kind === "inspect") await this.inspect(job);
      else if (job.kind === "remove" || job.kind === "replace") await this.remove(job);
      else await this.scan(job);
    }
    return this.pending;
  }
  clear(): void {
    for (const source of this.sources.values()) this.catalog.removeSource(source);
    this.sources.clear();
  }
  async close(): Promise<void> {
    this.jobs.clear();
    for (const slot of this.scans.keys()) await this.stopScan(slot);
  }
}
