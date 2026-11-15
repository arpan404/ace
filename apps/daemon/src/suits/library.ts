import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  SuitId,
  type SuitDetail,
  type SuitRequest,
  type SuitResponse,
  type SuitSummary,
} from "@ace/protocol/suits";
import { suitLimits } from "@ace/suits";
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
  /** Sanitised suit.css per read version, so repeated reads don't parse it again. */
  readonly #css = new WeakMap<ReadSuit, string | null>();
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
    const sceneUrl = read.plan.read.includes("scene.js") ? `${base}scene.html` : null;
    const sceneUrls: SuitDetail["sceneUrls"] = sceneUrl ? { app: sceneUrl } : {};
    let css = this.#css.get(read);
    if (css === undefined) {
      css = suitCss(id, read.inspected, read.plan.read, (path) => base + encodeSuitPath(path));
      this.#css.set(read, css);
    }
    // Ornaments and region scenes are served once their sanitiser lands (ADR 0150).
    return {
      op: "read",
      suit: { summary, manifest, sceneUrl, sceneUrls, assets, css, ornaments: {} },
    };
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

  /**
   * A file of one version of a Suit, for the asset URLs: only scene.js and files under assets/
   * that the checks let through, and only while the Suit still has `hash`.
   */
  async file(id: string, hash: string, path: string): Promise<SuitFile | undefined> {
    if (path !== "scene.js" && !path.startsWith("assets/")) return undefined;
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
