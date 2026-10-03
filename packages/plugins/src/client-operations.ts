import { readSourcePage, sourcePage } from "./source-page.ts";
import { inlineSource } from "./inline-source.ts";
import { cp, open, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PluginAvailability, PluginName, PluginReview } from "@ace/protocol/plugins";
import { limits, normalizePath } from "./manifest.ts";
import { assertNoSymlinks, inspectPackage, readPackageText } from "./files.ts";
import { importPlugin } from "./import.ts";
import { reviewPlugin, validateComponents } from "./review.ts";
import { jsonSize, reviewBytes } from "./review-pages.ts";
import type { Registry } from "./registry.ts";
import type { PluginSnapshot, PackageFile } from "./types.ts";
/** Client catalog and review preparation share the manager's registry and immutable snapshots. */
export class PluginClientOperations {
  private registry: Registry;
  private root: string;
  private id: () => string;
  private indexedSnapshots: PluginSnapshot[] | undefined;
  private components: Omit<
    import("@ace/protocol/plugins").PluginComponent,
    "enabled" | "providers"
  >[] = [];
  private snapshots: () => Promise<PluginSnapshot[]>;
  private sourceSnapshots: PluginSnapshot[] | undefined;
  private sourceIndex = new Map<
    string,
    { snapshot: PluginSnapshot; files: Map<string, PackageFile> }
  >();
  private inlinePages = new Map<string, { path: string; hash: string; bytes: Buffer }>();
  private inlineBytes = 0;
  constructor(
    registry: Registry,
    root: string,
    id: () => string,
    snapshots: () => Promise<PluginSnapshot[]>,
  ) {
    this.registry = registry;
    this.root = root;
    this.id = id;
    this.snapshots = snapshots;
  }
  availability(name: string): PluginAvailability {
    PluginName.parse(name);
    return (
      this.registry.availability(name) ?? {
        name,
        enabled: true,
        providers: ["claude", "codex", "opencode", "cursor", "antigravity", "acp"],
      }
    );
  }
  configure(value: PluginAvailability): PluginAvailability {
    const input = PluginAvailability.parse(value);
    if (!this.registry.installs().some((entry) => entry.install.name === input.name))
      throw new Error("Plugin not installed");
    this.registry.configure(input);
    return input;
  }
  selected(provider: import("./types.ts").Provider, snapshots: PluginSnapshot[]): PluginSnapshot[] {
    return snapshots.filter((snapshot) => {
      const policy = this.availability(snapshot.install.name);
      return policy.enabled && policy.providers.includes(provider);
    });
  }
  async catalog(offset: number, limit: number) {
    const snapshots = await this.snapshots();
    if (this.indexedSnapshots !== snapshots) {
      const components: typeof this.components = [];
      for (const snapshot of snapshots)
        for (const [kind, entries] of [
          ["skill", snapshot.manifest.skills],
          ["command", snapshot.manifest.commands],
          ["agent", snapshot.manifest.agents],
          ["rule", snapshot.manifest.rules],
        ] as const)
          for (const entry of entries) {
            if (components.length >= limits.files * 4) throw new Error("Catalog component limit");
            components.push({
              plugin: snapshot.install.name,
              name: entry.name,
              kind,
              path:
                kind === "skill"
                  ? `${normalizePath(entry.path)}/SKILL.md`
                  : normalizePath(entry.path),
              description: entry.description ?? "",
            });
          }
      this.components = components;
      this.indexedSnapshots = snapshots;
    }
    // A page has at most 50 components. Resolve each plugin policy once per page.
    const policies = new Map<string, PluginAvailability>();
    const components = this.components.slice(offset, offset + limit).map((entry) => {
      const availability = policies.get(entry.plugin) ?? this.availability(entry.plugin);
      policies.set(entry.plugin, availability);
      return Object.assign({}, entry, {
        enabled: availability.enabled,
        providers: availability.providers,
      });
    });
    return {
      components,
      ...(offset + components.length < this.components.length
        ? { nextOffset: offset + components.length }
        : {}),
    };
  }
  async source(name: string, path: string, offset: number, limit: number) {
    const snapshots = await this.snapshots();
    if (this.sourceSnapshots !== snapshots) {
      this.inlinePages.clear();
      this.inlineBytes = 0;
      this.sourceSnapshots = snapshots;
      this.sourceIndex.clear();
      for (const snapshot of snapshots)
        this.sourceIndex.set(snapshot.install.name, {
          snapshot,
          files: new Map(snapshot.files.map((file) => [file.path, file])),
        });
    }
    const indexed = this.sourceIndex.get(PluginName.parse(name));
    if (!indexed) throw new Error("Plugin not installed");
    const { snapshot, files } = indexed;
    const relative = normalizePath(path);
    const key = `${name}/${relative}`;
    let virtual = this.inlinePages.get(key);
    if (!virtual) {
      const source = inlineSource(snapshot.text, relative);
      if (source) {
        const bytes = Buffer.from(source.text);
        virtual = { path: source.path, hash: source.hash, bytes };
        // FIFO eviction bounds encoded data independently of the snapshot text cache.
        while (
          this.inlinePages.size >= limits.files ||
          this.inlineBytes + bytes.length > limits.total
        ) {
          const oldest = this.inlinePages.keys().next().value;
          if (oldest === undefined) throw new Error("Source cache limit");
          this.inlineBytes -= this.inlinePages.get(oldest)?.bytes.length ?? 0;
          this.inlinePages.delete(oldest);
        }
        this.inlinePages.set(key, virtual);
        this.inlineBytes += bytes.length;
      }
    }
    if (virtual)
      return {
        path: join(snapshot.root, virtual.path),
        hash: virtual.hash,
        ...sourcePage(
          virtual.bytes.subarray(offset, offset + Math.max(4, limit) + 1),
          virtual.bytes.length,
          offset,
          limit,
        ),
        readonly: true as const,
        virtual: true,
        manifestPath: virtual.path,
      };
    const file = files.get(relative);
    if (!file || offset > file.bytes) throw new Error("Source unavailable");
    return {
      path: join(snapshot.root, relative),
      hash: file.hash,
      ...(await readSourcePage(join(snapshot.root, relative), file, offset, limit)),
      readonly: true as const,
    };
  }

  async edit(request: {
    name: string;
    path: string;
    expectedHash: string;
    text: string;
  }): Promise<PluginReview> {
    const installed = this.registry
      .installs()
      .find((entry) => entry.install.name === PluginName.parse(request.name));
    if (!installed || this.registry.summaries().length >= limits.pending)
      throw new Error("Review unavailable");
    const root = join(this.root, "versions", installed.install.hash);
    const digest = await inspectPackage(root);
    if (digest.hash !== installed.install.hash) throw new Error("Integrity mismatch");
    const path = normalizePath(request.path);
    const source = digest.files.find((entry) => entry.path === path);
    const virtual = source
      ? undefined
      : inlineSource(await readPackageText(root, digest.files), path);
    const hash = source?.hash ?? virtual?.hash;
    if (
      hash === undefined ||
      hash !== request.expectedHash ||
      Buffer.byteLength(request.text) > 262144
    )
      throw new Error("Source changed or too large");
    const id = PluginReview.shape.id.parse(this.id());
    const stage = join(this.root, "staging", id);
    await assertNoSymlinks(stage);
    await mkdir(stage, { mode: 0o700 });
    try {
      await cp(root, stage, { recursive: true, force: false, errorOnExist: true });
      const editPath = virtual?.path ?? path;
      const replacement = virtual ? virtual.replace(request.text) : request.text;
      await writeFile(join(stage, editPath), replacement, { flag: "r+" });
      // writeFile with r+ does not truncate; replace only this staged file.
      const edited = await open(join(stage, editPath), "r+");
      try {
        await edited.truncate(Buffer.byteLength(replacement));
        await edited.sync();
      } finally {
        await edited.close();
      }
      const next = await inspectPackage(stage);
      const text = await readPackageText(stage, next.files);
      const imported = importPlugin(text);
      validateComponents(imported, text);
      const review = reviewPlugin(imported, {
        id,
        commit: installed.install.commit,
        hash: next.hash,
      });
      jsonSize(review, reviewBytes);
      this.registry.saveReview({ review, repository: installed.repository, ref: installed.ref });
      return review;
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }
}
