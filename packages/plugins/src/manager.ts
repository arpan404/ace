import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { withDirectoryLock } from "./lock.ts";
import { PluginInstall, PluginName, PluginReview } from "@ace/protocol/plugins";
import { Marketplace, limits, normalizePath, parseJson } from "./manifest.ts";
import {
  assertNoSymlinks,
  inspectPackage,
  isMissing,
  ownDirectory,
  readPackageText,
} from "./files.ts";
import { extractPlugin, fetchRepository, readGitFile } from "./git.ts";
import { importPlugin } from "./import.ts";
import { Registry } from "./registry.ts";
import { reviewPlugin, validateComponents } from "./review.ts";
import type { PluginSnapshot } from "./types.ts";

export interface PluginManagerOptions {
  root: string;
  now: () => number;
  id: () => string;
}
export class PluginManager {
  private registry: Registry;
  private root: string;
  private options: PluginManagerOptions;
  private constructor(root: string, options: PluginManagerOptions) {
    this.root = root;
    this.options = options;
    this.registry = new Registry(join(root, "registry.sqlite"));
  }
  static async open(options: PluginManagerOptions): Promise<PluginManager> {
    const root = await ownDirectory(options.root);
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      await assertNoSymlinks(join(root, "registry.sqlite") + suffix);
    const manager = new PluginManager(root, options);
    try {
      await manager.lock(async () => {
        await manager.collect();
      });
      return manager;
    } catch (error) {
      manager.close();
      throw error;
    }
  }
  private lock<T>(run: () => Promise<T>): Promise<T> {
    return withDirectoryLock(this.root, run);
  }
  private async collect(): Promise<void> {
    const installs = this.registry.installs();
    const reviews = this.registry.reviews();
    if (installs.length > limits.installs || reviews.length > limits.pending)
      throw new Error("Registry exceeds limits");
    for (const [directory, keep] of [
      ["versions", new Set(installs.map(({ install }) => install.hash))],
      ["staging", new Set(reviews.map(({ review }) => review.id))],
      ["fetch", new Set<string>()],
    ] as const) {
      const root = join(this.root, directory);
      await assertNoSymlinks(root);
      await mkdir(root, { recursive: true, mode: 0o700 });
      for (const entry of await readdir(root))
        if (!keep.has(entry)) await rm(join(root, entry), { recursive: true, force: true });
    }
  }
  async prepare(request: { repository: string; ref: string; name: string }): Promise<PluginReview> {
    const name = PluginName.parse(request.name);
    return this.lock(async () => {
      if (this.registry.reviews().length >= limits.pending) throw new Error("Pending review limit");
      const id = PluginReview.shape.id.parse(this.options.id());
      if (this.registry.reviews().some((stored) => stored.review.id === id))
        throw new Error("Duplicate review id");
      const temporary = join(this.root, "fetch", id);
      const stage = join(this.root, "staging", id);
      await assertNoSymlinks(temporary);
      await assertNoSymlinks(stage);
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      await mkdir(stage, { recursive: true, mode: 0o700 });
      try {
        const { gitRoot, commit } = await fetchRepository(
          request.repository,
          request.ref,
          temporary,
        );
        let catalogText: string | undefined;
        for (const path of [
          "marketplace.json",
          ".claude-plugin/marketplace.json",
          ".cursor-plugin/marketplace.json",
        ]) {
          try {
            catalogText = await readGitFile(gitRoot, commit, path);
            break;
          } catch (error) {
            if (!(error instanceof Error && error.message.includes("does not exist"))) throw error;
          }
        }
        if (catalogText === undefined) throw new Error("Marketplace missing");
        const catalog = Marketplace.parse(parseJson(catalogText));
        const entry = catalog.plugins.find((plugin) => plugin.name === name);
        if (!entry) throw new Error("Plugin not in marketplace");
        await extractPlugin(
          gitRoot,
          commit,
          entry.source === "." || entry.source === "./" ? "." : normalizePath(entry.source),
          stage,
        );
        const digest = await inspectPackage(stage);
        if (entry.hash !== undefined && entry.hash !== digest.hash)
          throw new Error("Integrity mismatch");
        const text = await readPackageText(stage, digest.files);
        const imported = importPlugin(text);
        if (imported.manifest.name !== name) throw new Error("Catalog and manifest name mismatch");
        validateComponents(imported, text);
        const review = reviewPlugin(imported, { id, commit, hash: digest.hash });
        this.registry.saveReview({ review, repository: request.repository, ref: request.ref });
        return review;
      } catch (error) {
        await rm(stage, { recursive: true, force: true });
        throw error;
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }
  async update(name: string): Promise<PluginReview> {
    const previous = this.registry
      .installs()
      .find((value) => value.install.name === PluginName.parse(name));
    if (!previous) throw new Error("Plugin not installed");
    return this.prepare({ repository: previous.repository, ref: previous.ref, name });
  }
  async accept(approval: { id: string; commit: string; hash: string }): Promise<PluginInstall> {
    return this.lock(async () => {
      const stored = this.registry.review(PluginReview.shape.id.parse(approval.id));
      const { review } = stored;
      if (approval.commit !== review.commit || approval.hash !== review.hash)
        throw new Error("Consent does not match reviewed version");
      const stage = join(this.root, "staging", review.id);
      if ((await inspectPackage(stage)).hash !== review.hash) throw new Error("Integrity mismatch");
      const installed = this.registry.installs();
      if (
        installed.length >= limits.installs &&
        !installed.some((value) => value.install.name === review.name)
      )
        throw new Error("Install limit");
      const destination = join(this.root, "versions", review.hash);
      await assertNoSymlinks(destination);
      try {
        if ((await inspectPackage(destination)).hash !== review.hash)
          throw new Error("Integrity mismatch");
      } catch (error) {
        if (!isMissing(error)) throw error;
        await rename(stage, destination);
      }
      const install = PluginInstall.parse({
        name: review.name,
        version: review.version,
        commit: review.commit,
        hash: review.hash,
        acceptedAt: this.options.now(),
      });
      this.registry.accept({ install, repository: stored.repository, ref: stored.ref }, review.id);
      await this.collect();
      return install;
    });
  }
  pending(): PluginReview[] {
    return this.registry.reviews().map((value) => value.review);
  }
  list(): PluginInstall[] {
    return this.registry.installs().map((value) => value.install);
  }
  async installed(): Promise<PluginSnapshot[]> {
    return this.lock(async () => {
      const snapshots: PluginSnapshot[] = [];
      let total = 0;
      let selectedFiles = 0;
      for (const { install } of this.registry.installs()) {
        const root = join(this.root, "versions", install.hash);
        const digest = await inspectPackage(root);
        if (digest.hash !== install.hash) throw new Error("Integrity mismatch");
        selectedFiles += digest.files.length;
        if (selectedFiles > limits.files) throw new Error("Selected plugins exceed file limit");
        for (const file of digest.files) total += file.bytes;
        if (total > limits.total) throw new Error("Selected plugins exceed projection byte limit");
        const text = await readPackageText(root, digest.files);
        const imported = importPlugin(text);
        validateComponents(imported, text);
        snapshots.push({
          install,
          manifest: imported.manifest,
          root,
          files: digest.files,
          text: { ...text, ...imported.inlineFiles },
          unsupported: imported.unsupported,
        });
      }
      return snapshots;
    });
  }
  async remove(name: string): Promise<void> {
    await this.lock(async () => {
      this.registry.remove(PluginName.parse(name));
      await this.collect();
    });
  }
  async cancel(id: string): Promise<void> {
    await this.lock(async () => {
      this.registry.cancel(PluginReview.shape.id.parse(id));
      await this.collect();
    });
  }
  close(): void {
    this.registry.close();
  }
}
