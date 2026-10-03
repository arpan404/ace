import { constants } from "node:fs";
import { inlineSource, inlinePage } from "./inline-source.ts";
import { cp, open, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PluginAvailability, PluginName, PluginReview } from "@ace/protocol/plugins";
import { limits, normalizePath } from "./manifest.ts";
import { assertNoSymlinks, inspectPackage, readPackageText } from "./files.ts";
import { importPlugin } from "./import.ts";
import { reviewPlugin, validateComponents } from "./review.ts";
import { jsonSize, reviewBytes } from "./review-pages.ts";
import type { Registry } from "./registry.ts";
import type { PluginSnapshot } from "./types.ts";
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
    const snapshot = (await this.snapshots()).find(
      (entry) => entry.install.name === PluginName.parse(name),
    );
    if (!snapshot) throw new Error("Plugin not installed");
    const relative = normalizePath(path);
    const virtual = inlineSource(snapshot.text, relative);
    if (virtual)
      return {
        path: join(snapshot.root, virtual.path),
        hash: virtual.hash,
        ...inlinePage(virtual.text, offset, limit),
        readonly: true as const,
        virtual: true,
        manifestPath: virtual.path,
      };
    const file = snapshot.files.find((entry) => entry.path === relative);
    if (!file || offset > file.bytes) throw new Error("Source unavailable");
    await assertNoSymlinks(join(snapshot.root, relative));
    const handle = await open(
      join(snapshot.root, relative),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const bytes = Buffer.alloc(Math.min(Math.max(4, limit), file.bytes - offset));
      const read = await handle.read(bytes, 0, bytes.length, offset);
      // Byte cursors always end on a UTF-8 boundary. At least one code point fits.
      let end = read.bytesRead;
      if (offset + end < file.bytes) {
        const next = Buffer.alloc(1);
        await handle.read(next, 0, 1, offset + end);
        if ((next[0] ?? 0) >= 0x80 && (next[0] ?? 0) < 0xc0) {
          while (end > 0 && (bytes[end - 1] ?? 0) >= 0x80 && (bytes[end - 1] ?? 0) < 0xc0) end--;
          if (end > 0) end--;
        }
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
      return {
        path: join(snapshot.root, relative),
        hash: file.hash,
        bytes: file.bytes,
        offset,
        nextOffset: offset + end,
        text,
        readonly: true as const,
      };
    } finally {
      await handle.close();
    }
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
