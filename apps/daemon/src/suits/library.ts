import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  SuitId,
  type SuitDetail,
  type SuitManifest,
  type SuitRequest,
  type SuitResponse,
  type SuitSummary,
} from "@ace/protocol/suits";
import { isSceneFile, regionOrnaments, regionScenes, scenePageFor, suitLimits } from "@ace/suits";
import { suitCss } from "@ace/suits/folder";
import { isMissing, readSuit, readSuitFile, type ReadSuit } from "./reader.ts";
import { encodeSuitPath, SuitUrls } from "./urls.ts";

/*
 * The Suit library (ADR 0150): every folder under the per-user `suits/` root, listed, read,
 * checked and removed, and one `changed` notice per settled burst of edits on disk. Reads are
 * cached by each folder's signature, so a list re-reads only the folders that changed.
 */

/** Calls `changed` on any change under `root`; returns its stop, or undefined if it can't. */
export type SuitWatch = (root: string, changed: () => void) => (() => void) | undefined;
/** Runs `run` after `ms`; returns its cancel. */
export type SuitSchedule = (run: () => void, ms: number) => () => void;

export interface SuitLibraryOptions {
  root: string;
  /** The key of this run's asset URL grants (`SuitUrls`). */
  key: Uint8Array;
  watch: SuitWatch;
  schedule: SuitSchedule;
  /** How long the folder must stay quiet before a change is announced. */
  settleMs?: number;
}

export interface SuitFile {
  bytes: Buffer;
  path: string;
}

const largest = Math.max(suitLimits.manifestBytes, suitLimits.sceneBytes, suitLimits.assetBytes);

export class SuitLibrary {
  readonly urls: SuitUrls;
  readonly #options: SuitLibraryOptions;
  readonly #cache = new Map<string, ReadSuit>();
  /** Sanitised suit.css and ornaments per read version, so repeated reads don't parse again. */
  readonly #served = new WeakMap<ReadSuit, Pick<SuitDetail, "css" | "ornaments">>();
  readonly #listeners = new Set<(suits: SuitSummary[]) => void>();
  #stopWatch: (() => void) | undefined;
  #cancelSettle: (() => void) | undefined;
  #last: string | undefined;
  #announcing: Promise<void> = Promise.resolve();

  constructor(options: SuitLibraryOptions) {
    this.#options = options;
    this.urls = new SuitUrls(options.key);
  }

  /** Makes the root and starts watching it. */
  async start(): Promise<void> {
    await mkdir(this.#options.root, { recursive: true });
    this.#last = JSON.stringify(await this.list());
    this.#stopWatch = this.#options.watch(this.#options.root, () => this.changed());
  }

  close(): void {
    this.#stopWatch?.();
    this.#stopWatch = undefined;
    this.#cancelSettle?.();
    this.#cancelSettle = undefined;
    this.#listeners.clear();
  }

  /** `listener` hears the new list after each settled change that altered it. */
  subscribe(listener: (suits: SuitSummary[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Something under the root changed: announce once it settles. */
  changed(): void {
    this.#cancelSettle?.();
    this.#cancelSettle = this.#options.schedule(() => {
      this.#cancelSettle = undefined;
      this.#announcing = this.#announcing.then(() => this.#announce()).catch(() => {});
    }, this.#options.settleMs ?? 150);
  }

  async #announce(): Promise<void> {
    const suits = await this.list();
    const encoded = JSON.stringify(suits);
    if (encoded === this.#last) return;
    this.#last = encoded;
    for (const listener of this.#listeners) listener(suits);
  }

  async list(): Promise<SuitSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.#options.root);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const ids = names.filter((name) => SuitId.safeParse(name).success).toSorted();
    for (const id of this.#cache.keys()) if (!ids.includes(id)) this.#cache.delete(id);
    const suits: SuitSummary[] = [];
    for (const id of ids) {
      const read = await this.#read(id, true);
      if (read) suits.push(read.inspected.summary);
    }
    return suits;
  }

  async #read(id: string, cached: boolean): Promise<ReadSuit | undefined> {
    const previous = cached ? this.#cache.get(id) : undefined;
    const read = await readSuit(this.#options.root, id, largest, previous);
    if (read) this.#cache.set(id, read);
    else this.#cache.delete(id);
    return read;
  }

  /** The Suit ready to apply, with its scene and assets as served URLs. */
  async read(id: string): Promise<SuitResponse> {
    const read = await this.#read(id, true);
    if (!read) return notFound(id);
    const { summary, manifest } = read.inspected;
    if (!manifest)
      return {
        op: "error",
        code: "invalid",
        message: `${id}'s suit.json is missing or doesn't parse`,
        summary,
      };
    const base = this.urls.base(id, summary.contentHash);
    const assets: SuitDetail["assets"] = {};
    for (const path of read.plan.read)
      if (path.startsWith("assets/")) assets[path] = base + encodeSuitPath(path);
    const files = new Set(read.plan.read);
    const sceneUrls: SuitDetail["sceneUrls"] = {};
    for (const [region, file] of Object.entries(regionScenes(manifest, files).scenes))
      sceneUrls[region as keyof SuitDetail["sceneUrls"]] =
        base + encodeSuitPath(scenePageFor(file));
    const sceneUrl = sceneUrls.app ?? null;
    let served = this.#served.get(read);
    if (served === undefined) {
      const url = (path: string) => base + encodeSuitPath(path);
      served = {
        css: suitCss(id, read.inspected, read.plan.read, url),
        ornaments: manifest.ornaments?.length
          ? regionOrnaments(
              manifest,
              await this.#ornamentFiles(id, summary.contentHash, manifest),
              (path) => assets[path],
            ).ornaments
          : {},
      };
      this.#served.set(read, served);
    }
    return {
      op: "read",
      suit: { summary, manifest, sceneUrl, sceneUrls, assets, ...served },
    };
  }

  /** The ornament files suit.json names, read from the folder as the checks saw them. */
  async #ornamentFiles(
    id: string,
    hash: string,
    manifest: SuitManifest,
  ): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    for (const { asset } of manifest.ornaments ?? []) {
      if (files.has(asset)) continue;
      const file = await this.file(id, hash, asset);
      if (file) files.set(asset, file.bytes);
    }
    return files;
  }

  /** Every check again on the folder as it is on disk now, past any cache. */
  async validate(id: string): Promise<SuitResponse> {
    const read = await this.#read(id, false);
    return read ? { op: "validate", summary: read.inspected.summary } : notFound(id);
  }

  async remove(id: string): Promise<SuitResponse> {
    const folder = join(this.#options.root, id);
    try {
      await lstat(folder);
    } catch (error) {
      if (isMissing(error)) return { op: "remove", removed: false };
      throw error;
    }
    // A link is removed as a link: what it points at is never touched.
    await rm(folder, { recursive: true, force: true });
    this.#cache.delete(id);
    this.changed();
    return { op: "remove", removed: true };
  }

  /**
   * Installs a Suit from files already checked and verified (a marketplace version, ADR 0168):
   * written under a dot name the library never lists, then moved in whole, replacing the folder
   * only when `replace` says the caller owns it (an update of the same install). It is stored,
   * never applied: wearing it stays each device's choice.
   */
  async install(
    id: string,
    files: readonly { path: string; executable: boolean; content: Uint8Array }[],
    options: { replace: boolean },
  ): Promise<SuitSummary> {
    const suitId = SuitId.parse(id);
    const folder = join(this.#options.root, suitId);
    const staging = join(this.#options.root, `.installing-${suitId}`);
    const old = join(this.#options.root, `.replaced-${suitId}`);
    const exists = await lstat(folder).then(
      () => true,
      (error: unknown) => {
        if (isMissing(error)) return false;
        throw error;
      },
    );
    if (exists && !options.replace) throw new Error(`There is already a Suit ${suitId}`);
    await rm(staging, { recursive: true, force: true });
    await rm(old, { recursive: true, force: true });
    let movedAside = false;
    try {
      for (const file of files) {
        const target = join(staging, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content, {
          flag: "wx",
          mode: file.executable ? 0o755 : 0o644,
        });
      }
      if (exists) {
        await rename(folder, old);
        movedAside = true;
      }
      await rename(staging, folder);
      movedAside = false;
    } catch (error) {
      // The new folder never landed: the one it was replacing goes back.
      if (movedAside) await rename(old, folder);
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(old, { recursive: true, force: true });
    }
    this.#cache.delete(suitId);
    this.changed();
    const read = await this.#read(suitId, false);
    if (!read) throw new Error(`${suitId} didn't land in the library`);
    return read.inspected.summary;
  }

  request(request: SuitRequest): Promise<SuitResponse> {
    switch (request.op) {
      case "list":
        return this.list().then((suits) => ({ op: "list", suits }));
      case "read":
        return this.read(request.id);
      case "validate":
        return this.validate(request.id);
      case "remove":
        return this.remove(request.id);
    }
  }

  /** A scene file of one version of a Suit, when it has any (the runtime is served beside it). */
  async anyScene(id: string, hash: string): Promise<SuitFile | undefined> {
    const read = await this.#read(id, true);
    if (!read || read.inspected.summary.contentHash !== hash) return undefined;
    const path = read.plan.read.find(isSceneFile);
    return path ? this.file(id, hash, path) : undefined;
  }

  /**
   * A file of one version of a Suit, for the asset URLs: only scene files and files under assets/
   * that the checks let through, and only while the Suit still has `hash`.
   */
  async file(id: string, hash: string, path: string): Promise<SuitFile | undefined> {
    if (!isSceneFile(path) && !path.startsWith("assets/")) return undefined;
    const read = await this.#read(id, true);
    if (!read || read.inspected.summary.contentHash !== hash || !read.plan.read.includes(path))
      return undefined;
    const bytes = await readSuitFile(join(this.#options.root, id), path, largest).catch(
      () => undefined,
    );
    // Changed between the check and the read: that version is gone.
    const again = await this.#read(id, true);
    if (!bytes || again?.inspected.summary.contentHash !== hash) return undefined;
    return { bytes, path };
  }
}

const notFound = (id: string): SuitResponse => ({
  op: "error",
  code: "not_found",
  message: `There is no Suit ${id}`,
});
