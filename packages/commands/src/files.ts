import { watch, constants, type FSWatcher } from "node:fs";
import { lstat, opendir, open, realpath } from "node:fs/promises";
import { dirname, basename, relative, resolve, sep, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CommandCatalog, type ProviderInstance } from "./catalog.ts";
import { parseMarkdown, parseOpenCodeConfig } from "./parse.ts";
import type { ParseContext } from "./types.ts";

export interface DiscoveryRoot {
  path: string;
  format: ParseContext["format"] | "opencode-config";
  scope: "user" | "workspace";
  instance?: string | undefined;
  skill?: boolean | undefined;
  trustedRoot?: string | undefined;
}
export function discoveryRoots(
  instances: readonly ProviderInstance[],
  aceHome: string,
  workspace: string,
): DiscoveryRoot[] {
  const roots: DiscoveryRoot[] = [
    { path: join(aceHome, "prompts"), trustedRoot: aceHome, format: "library", scope: "user" },
    {
      path: join(workspace, ".ace/prompts"),
      trustedRoot: workspace,
      format: "library",
      scope: "workspace",
    },
  ];
  for (const instance of instances) {
    const scopes = [
      { path: instance.home, scope: "user" as const },
      { path: join(workspace, `.${instance.provider}`), scope: "workspace" as const },
    ];
    if (instance.provider === "claude")
      for (const scope of scopes) {
        roots.push({
          path: join(scope.path, "commands"),
          scope: scope.scope,
          format: "claude",
          instance: instance.id,
          trustedRoot: scope.scope === "workspace" ? workspace : instance.home,
        });
        roots.push({
          path: join(scope.path, "skills"),
          scope: scope.scope,
          format: "claude",
          instance: instance.id,
          trustedRoot: scope.scope === "workspace" ? workspace : instance.home,
          skill: true,
        });
      }
    else if (instance.provider === "codex")
      for (const scope of scopes)
        roots.push({
          path: join(scope.path, "prompts"),
          scope: scope.scope,
          format: "codex",
          instance: instance.id,
          trustedRoot: scope.scope === "workspace" ? workspace : instance.home,
        });
    else if (instance.provider === "opencode") {
      for (const scope of scopes) {
        for (const folder of ["command", "commands"])
          roots.push({
            path: join(scope.path, folder),
            scope: scope.scope,
            format: "opencode",
            instance: instance.id,
            trustedRoot: scope.scope === "workspace" ? workspace : instance.home,
          });
        for (const file of ["opencode.json", "opencode.jsonc"])
          roots.push({
            path: join(scope.scope === "workspace" ? workspace : scope.path, file),
            scope: scope.scope,
            format: "opencode-config",
            instance: instance.id,
            trustedRoot: scope.scope === "workspace" ? workspace : instance.home,
          });
      }
    }
  }
  return roots;
}
const rootSchema = z.object({
  path: z.string().min(1),
  format: z.enum(["library", "claude", "codex", "opencode", "opencode-config"]),
  scope: z.enum(["user", "workspace"]),
  instance: z.string().max(128).optional(),
  skill: z.boolean().optional(),
  trustedRoot: z.string().optional(),
});
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
const sourceId = (root: DiscoveryRoot, path: string) =>
  createHash("sha256")
    .update(`${root.instance ?? "library"}:${root.scope}:${root.format}:${path}`)
    .digest("hex")
    .slice(0, 24);
async function readBounded(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error("Not a regular file");
    const buffer = Buffer.alloc(65537);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset > 65536) throw new Error("Command exceeds 64 KiB");
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await file.close();
  }
}
export class CommandFiles {
  private readonly catalog: CommandCatalog;
  private readonly roots: DiscoveryRoot[];
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly children = new Map<string, Set<string>>();
  private readonly sources = new Map<string, string>();
  private readonly pending = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private timer: NodeJS.Timeout | undefined;
  private work: Promise<void> = Promise.resolve();
  private closed = false;
  private links = 0;
  constructor(catalog: CommandCatalog, roots: readonly DiscoveryRoot[]) {
    this.catalog = catalog;
    this.roots = z
      .array(rootSchema)
      .max(32)
      .parse(roots)
      .map((root) => Object.assign(root, { path: resolve(root.path) }));
  }
  private watchDirectory(root: DiscoveryRoot, path: string): void {
    const key = `${sourceId(root, root.path)}:${path}`;
    if (this.watchers.has(key)) return;
    if (this.watchers.size >= 128) {
      this.report(root, path, "Watcher limit exceeded; explicit refresh required");
      return;
    }
    try {
      const watcher = watch(path, (_event, file) => {
        if (!file) {
          this.invalidate(root.path);
          return;
        }
        const changed = resolve(path, String(file));
        if (inside(root.path, changed)) this.invalidate(changed);
        else if (inside(changed, root.path)) this.invalidate(root.path);
      });
      watcher.on("error", () =>
        this.report(root, path, "File watcher unavailable; explicit refresh required"),
      );
      watcher.unref();
      this.watchers.set(key, watcher);
    } catch {
      this.report(root, path, "File watcher unavailable; explicit refresh required");
    }
  }
  private async watchAncestor(root: DiscoveryRoot): Promise<void> {
    let parent = dirname(root.path);
    while (true) {
      try {
        if ((await lstat(parent)).isDirectory()) break;
      } catch {
        /* nearest existing ancestor */
      }
      const next = dirname(parent);
      if (next === parent) return;
      parent = next;
    }
    this.watchDirectory(root, parent);
  }
  async start(): Promise<void> {
    for (const root of this.roots) {
      await this.watchAncestor(root);
      await this.sync(root, root.path, 0);
    }
  }
  /** Subscription wakes clients/tests after a complete batch, without polling or sleeps. */
  subscribe(listener: () => void): () => void {
    if (this.listeners.size >= 64) throw new Error("Listener limit");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  invalidate(path: string): void {
    if (this.closed) return;
    if (this.pending.size >= 256) {
      this.pending.clear();
      for (const root of this.roots) this.pending.add(root.path);
    } else this.pending.add(resolve(path));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 30);
    this.timer.unref();
  }
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.work = this.work.then(async () => {
      const paths = [...this.pending];
      this.pending.clear();
      for (const path of paths)
        for (const root of this.roots)
          if (inside(root.path, path))
            await this.sync(root, path, relative(root.path, path).split(sep).length - 1);
      if (paths.length)
        for (const listener of this.listeners) {
          try {
            listener();
          } catch {
            /* A subscriber cannot stop discovery. */
          }
        }
    });
    await this.work;
  }
  private report(root: DiscoveryRoot, path: string, message: string): void {
    const id = sourceId(root, path);
    const key = `${root.instance ?? "library"}:${path}`;
    if (!this.sources.has(key) && this.sources.size >= 2048) return;
    if (this.catalog.replaceSource(id, { commands: [], diagnostics: [{ source: id, message }] }))
      this.sources.set(key, id);
  }
  private remove(root: DiscoveryRoot, path: string): void {
    const key = `${root.instance ?? "library"}:${path}`;
    if (this.children.get(`${root.instance ?? "library"}:${dirname(path)}`)?.delete(path))
      this.links--;
    for (const child of this.children.get(key) ?? []) this.remove(root, child);
    this.links -= this.children.get(key)?.size ?? 0;
    this.children.delete(key);
    const watchKey = `${sourceId(root, root.path)}:${path}`;
    this.watchers.get(watchKey)?.close();
    this.watchers.delete(watchKey);
    const id = this.sources.get(key);
    if (id) this.catalog.removeSource(id);
    this.sources.delete(key);
  }
  private async sync(root: DiscoveryRoot, path: string, depth: number): Promise<void> {
    if (this.closed) return;
    const key = `${root.instance ?? "library"}:${path}`;
    let stat;
    try {
      stat = await lstat(path);
    } catch {
      this.remove(root, path);
      if (path === root.path) await this.watchAncestor(root);
      return;
    }
    const parentChildren = this.children.get(`${root.instance ?? "library"}:${dirname(path)}`);
    if (parentChildren && !parentChildren.has(path)) {
      if (this.links >= 8192) {
        this.report(root, path, "Discovery path limit exceeded");
        return;
      }
      parentChildren.add(path);
      this.links++;
    }
    if (root.trustedRoot) {
      let parent = dirname(path);
      const anchor = resolve(root.trustedRoot);
      while (inside(anchor, parent) && parent !== anchor) {
        try {
          if ((await lstat(parent)).isSymbolicLink()) {
            this.remove(root, path);
            return;
          }
        } catch {
          this.remove(root, path);
          return;
        }
        parent = dirname(parent);
      }
      // A root outside its registered anchor is never read.
      if (!inside(anchor, path)) {
        this.remove(root, path);
        return;
      }
    }
    if (stat.isSymbolicLink()) {
      this.remove(root, path);
      return;
    }
    if (stat.isDirectory()) {
      if (
        root.format === "opencode-config" ||
        depth > 8 ||
        (root.format === "codex" && path !== root.path)
      )
        return;
      this.watchDirectory(root, path);
      if (!this.children.has(key) && this.children.size >= 2048) {
        this.report(root, path, "Directory limit exceeded");
        return;
      }
      try {
        const current = new Set<string>();
        const dir = await opendir(path);
        let count = 0;
        for await (const entry of dir) {
          if (++count > 2048) {
            this.report(root, path, "Directory entry limit exceeded");
            return;
          }
          if (!entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
            current.add(join(path, entry.name));
        }
        const oldChildren = this.children.get(key);
        const nextLinks = this.links - (oldChildren?.size ?? 0) + current.size;
        if (nextLinks > 8192) {
          this.report(root, path, "Discovery path limit exceeded");
          return;
        }
        for (const old of oldChildren ?? []) if (!current.has(old)) this.remove(root, old);
        const oldSource = this.sources.get(key);
        if (oldSource) {
          this.catalog.removeSource(oldSource);
          this.sources.delete(key);
        }
        this.links += current.size - (oldChildren?.size ?? 0);
        this.children.set(key, current);
        for (const child of current) await this.sync(root, child, depth + 1);
      } catch {
        this.report(root, path, "Cannot scan commands directory");
      }
      return;
    }
    if (
      !stat.isFile() ||
      (root.format !== "opencode-config" &&
        (!path.endsWith(".md") || (root.skill && basename(path) !== "SKILL.md")))
    )
      return;
    if (this.children.has(key)) {
      this.remove(root, path);
      if (parentChildren && !parentChildren.has(path)) {
        parentChildren.add(path);
        this.links++;
      }
    }
    if (!this.sources.has(key) && this.sources.size >= 2048) return;
    const id = sourceId(root, path);
    const name = root.skill
      ? basename(dirname(path))
      : relative(root.path, path).replace(/\.md$/, "").split(sep).join(":");
    const ctx = {
      source: id,
      name,
      scope: root.scope,
      ...(root.instance === undefined ? {} : { instance: root.instance }),
      ...(root.skill === undefined ? {} : { skill: root.skill }),
    };
    try {
      const resolvedPath = await realpath(path);
      const resolvedRoot = await realpath(
        root.format === "opencode-config" ? dirname(root.path) : root.path,
      );
      if (!inside(resolvedRoot, resolvedPath))
        throw new Error("Command escaped its discovery root");
      const text = await readBounded(resolvedPath);
      const parsed =
        root.format === "opencode-config"
          ? parseOpenCodeConfig(text, ctx)
          : parseMarkdown(text, { ...ctx, format: root.format });
      if (!this.catalog.replaceSource(id, parsed)) {
        this.report(root, path, "Catalog admission limit exceeded");
        return;
      }
      this.sources.set(key, id);
    } catch {
      this.report(root, path, "Cannot read command file within size limit");
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.pending.clear();
    this.listeners.clear();
    await this.work;
  }
}
