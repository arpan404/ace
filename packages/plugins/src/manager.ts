import { pluginCatalog } from "./extension-catalog.ts";
import { mkdir, opendir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { withDirectoryLock } from "./lock.ts";
import {
  PluginAvailability,
  PluginInstall,
  PluginListing,
  PluginName,
  PluginOrigin,
  PluginReview,
  PluginReviewOffset,
} from "@ace/protocol/plugins";
import { limits, normalizePath } from "./manifest.ts";
import {
  assertNoSymlinks,
  inspectPackage,
  isMissing,
  ownDirectory,
  readPackageText,
} from "./files.ts";
import {
  extractPlugin,
  fetchRepository,
  gitRuntime,
  readMarketplace,
  type GitRuntime,
} from "./git.ts";
import { importPlugin } from "./import.ts";
import { PluginClientOperations } from "./client-operations.ts";
import { Registry } from "./registry.ts";
import { jsonSize, reviewBytes, reviewPage } from "./review-pages.ts";
import { reviewPlugin, validateComponents } from "./review.ts";
import type { PluginSnapshot } from "./types.ts";

export interface PluginManagerOptions {
  root: string;
  now: () => number;
  id: () => string;
  git?: GitRuntime;
}
export class PluginManager {
  private registry: Registry;
  private client: PluginClientOperations;
  private root: string;
  private options: PluginManagerOptions;
  private git: GitRuntime;
  private cachedCatalog: { revision: number; snapshots: PluginSnapshot[] } | undefined;
  private constructor(root: string, options: PluginManagerOptions) {
    this.root = root;
    this.options = options;
    this.git = options.git ?? gitRuntime();
    this.registry = new Registry(join(root, "registry.sqlite"));
    this.client = new PluginClientOperations(this.registry, root, options.id, () =>
      this.catalogSnapshots(),
    );
  }
  static async open(options: PluginManagerOptions): Promise<PluginManager> {
    const manager = await PluginManager.openIndex(options);
    try {
      await manager.maintain(new AbortController().signal);
      return manager;
    } catch (error) {
      manager.close();
      throw error;
    }
  }
  static async openIndex(options: PluginManagerOptions): Promise<PluginManager> {
    const root = await ownDirectory(options.root);
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      await assertNoSymlinks(join(root, "registry.sqlite") + suffix);
    const manager = new PluginManager(root, options);
    return manager;
  }
  /** Cleanup is maintenance, not a prerequisite for opening the registry. */
  maintain(signal: AbortSignal): Promise<void> {
    return this.lock(() => this.collect(signal));
  }
  private lock<T>(run: () => Promise<T>): Promise<T> {
    return withDirectoryLock(this.root, run);
  }
  private async collect(signal?: AbortSignal): Promise<void> {
    const installs = this.registry.installs();
    const reviews = this.registry.summaries();
    if (installs.length > limits.installs || reviews.length > limits.pending)
      throw new Error("Registry exceeds limits");
    for (const [directory, keep] of [
      ["versions", new Set(installs.map(({ install }) => install.hash))],
      ["staging", new Set(reviews.map((review) => review.id))],
      ["fetch", new Set<string>()],
    ] as const) {
      const root = join(this.root, directory);
      await assertNoSymlinks(root);
      await mkdir(root, { recursive: true, mode: 0o700 });
      for await (const entry of await opendir(root)) {
        signal?.throwIfAborted();
        if (!keep.has(entry.name))
          await rm(join(root, entry.name), { recursive: true, force: true });
      }
    }
  }
  async prepare(request: { repository: string; ref: string; name: string }): Promise<PluginReview> {
    const name = PluginName.parse(request.name);
    return this.lock(async () => {
      if (this.registry.summaries().length >= limits.pending)
        throw new Error("Pending review limit");
      const id = PluginReview.shape.id.parse(this.options.id());
      if (this.registry.summaries().some((review) => review.id === id))
        throw new Error("Duplicate review id");
      const temporary = join(this.root, "fetch", id);
      const stage = join(this.root, "staging", id);
      await assertNoSymlinks(temporary);
      await assertNoSymlinks(stage);
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      await mkdir(stage, { recursive: true, mode: 0o700 });
      let released = false;
      try {
        const { gitRoot, commit } = await fetchRepository(
          request.repository,
          request.ref,
          temporary,
          this.git,
        );
        const catalog = await readMarketplace(gitRoot, commit, this.git);
        const entry = catalog.plugins.find((plugin) => plugin.name === name);
        if (!entry) throw new Error("Plugin not in marketplace");
        await extractPlugin(
          gitRoot,
          commit,
          entry.source === "." || entry.source === "./" ? "." : normalizePath(entry.source),
          stage,
          this.git,
        );
        const digest = await inspectPackage(stage);
        if (entry.hash !== undefined && entry.hash !== digest.hash)
          throw new Error("Integrity mismatch");
        const text = await readPackageText(stage, digest.files);
        const imported = importPlugin(text);
        if (imported.manifest.name !== name) throw new Error("Catalog and manifest name mismatch");
        validateComponents(imported, text);
        const review = reviewPlugin(imported, { id, commit, hash: digest.hash });
        jsonSize(review, reviewBytes);
        await this.git.release(temporary);
        released = true;
        this.registry.saveReview({ review, repository: request.repository, ref: request.ref });
        return review;
      } catch (error) {
        await rm(stage, { recursive: true, force: true });
        throw error;
      } finally {
        try {
          if (!released) await this.git.release(temporary);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      }
    });
  }
  /**
   * What a repository's marketplace offers, without fetching any plugin for review. `ref`
   * defaults to the remote's HEAD (its default branch).
   */
  async marketplace(request: {
    repository: string;
    ref?: string | undefined;
  }): Promise<{ ref: string; plugins: PluginListing[] }> {
    const ref = request.ref ?? "HEAD";
    return this.lock(async () => {
      const id = PluginReview.shape.id.parse(this.options.id());
      const temporary = join(this.root, "fetch", id);
      await assertNoSymlinks(temporary);
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      let released = false;
      try {
        const { gitRoot, commit } = await fetchRepository(
          request.repository,
          ref,
          temporary,
          this.git,
        );
        const catalog = await readMarketplace(gitRoot, commit, this.git);
        await this.git.release(temporary);
        released = true;
        return {
          ref,
          plugins: catalog.plugins.map((entry) =>
            PluginListing.parse({
              name: entry.name,
              ...(entry.description === undefined ? {} : { description: entry.description }),
              ...(entry.version === undefined ? {} : { version: entry.version }),
            }),
          ),
        };
      } finally {
        try {
          if (!released) await this.git.release(temporary);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
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
  readReview(id: string, offset: number) {
    return reviewPage(
      this.registry.review(PluginReview.shape.id.parse(id)).review,
      PluginReviewOffset.parse(offset),
    );
  }
  pendingSummaries() {
    return this.registry.summaries();
  }
  pending(): PluginReview[] {
    return this.registry.reviews().map((value) => value.review);
  }
  list(): PluginInstall[] {
    return this.registry.installs().map((value) => value.install);
  }
  /** Where each installed plugin came from: the repository and ref Update fetches again. */
  origins(): PluginOrigin[] {
    return this.registry.installs().map((value) =>
      PluginOrigin.parse({
        name: value.install.name,
        repository: value.repository,
        ref: value.ref,
      }),
    );
  }
  private async catalogSnapshots(): Promise<PluginSnapshot[]> {
    const currentRevision = this.registry.revision();
    if (this.cachedCatalog?.revision === currentRevision) return this.cachedCatalog.snapshots;
    return this.lock(async () => {
      const revision = this.registry.revision();
      if (this.cachedCatalog?.revision === revision) return this.cachedCatalog.snapshots;
      const snapshots = await this.readSnapshots();
      this.cachedCatalog = { revision, snapshots };
      return snapshots;
    });
  }
  async installed(): Promise<PluginSnapshot[]> {
    // Execution always verifies files again; catalog caching cannot authorize modified code.
    return this.lock(() => this.readSnapshots());
  }
  private async readSnapshots(): Promise<PluginSnapshot[]> {
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
  }
  availability(name: string) {
    return this.client.availability(name);
  }
  configure(value: PluginAvailability) {
    return this.client.configure(value);
  }
  configureSkill(value: import("@ace/protocol/plugins").PluginSkillAvailability) {
    return this.client.configureSkill(value);
  }
  async selected(provider: import("./types.ts").Provider) {
    return this.client.selected(provider, await this.installed());
  }
  async extensions(provider: import("@ace/protocol").ProviderKind) {
    const snapshots = await this.catalogSnapshots();
    return pluginCatalog(
      provider,
      snapshots.filter((s) => {
        const p = this.availability(s.install.name);
        return p.enabled && p.providers.includes(provider);
      }),
    );
  }
  catalog(offset: number, limit: number) {
    return this.client.catalog(offset, limit);
  }
  source(name: string, path: string, offset: number, limit: number) {
    return this.client.source(name, path, offset, limit);
  }
  edit(request: {
    name: string;
    path: string;
    expectedHash: string;
    text: string;
  }): Promise<PluginReview> {
    return this.lock(() => this.client.edit(request));
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
