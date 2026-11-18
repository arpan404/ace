import {
  FilesClient,
  FilesProcess,
  FilesRequestError,
  nodeFilesHost,
  systemFilesClock,
  type EventPayload,
  type FilesClock,
  type FilesHost,
  type FilesLog,
  type FilesWatch,
} from "@ace/files-native";
import type { FolderPage } from "@ace/protocol";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { filesBinaryPath } from "@ace/files-native/binary";
import { filesListDefaults } from "@ace/files-native/client";
import { folderPage } from "./page.ts";
import { FilesRoots, type RootHold } from "./roots.ts";

/** The ace-files this daemon runs: the bundled one in a release, the Cargo build in development. */
export function findFilesBinary(platform: NodeJS.Platform = process.platform): string | undefined {
  const entry = process.argv[1];
  if (entry && basename(entry) === "ace.mjs")
    return filesBinaryPath({ mode: "release", entry, platform, exists: existsSync });
  return filesBinaryPath({
    mode: "development",
    env: process.env,
    sourceRoot: fileURLToPath(new URL("../../../../", import.meta.url)),
    platform,
    exists: existsSync,
  });
}

/** The code a client sees for a failed file request; both error types carry one. */
export function filesErrorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "IO_ERROR";
}

/** The retryable error every feature needing ace-files carries when this install has none. */
export function aceFilesMissing(): FilesRequestError {
  return new FilesRequestError(
    "FILES_RESTARTING",
    "The Files panel needs ace-files, which this machine does not have yet: build native/files or set ACE_FILES_PATH, then retry",
  );
}

export type FilesToolOptions = {
  /** The binary, or undefined when this install has none; looked up once per daemon. */
  binary: string | undefined;
  host?: FilesHost | undefined;
  clock?: FilesClock | undefined;
  log?: FilesLog | undefined;
  /** How long a root nobody holds stays open; the plan's ten minutes. */
  idleMs?: number | undefined;
};

type RootWatch = {
  listeners: Set<(payload: EventPayload) => void>;
  hold?: RootHold | undefined;
  subscription?: FilesWatch | undefined;
  starting?: Promise<void> | undefined;
  closed: boolean;
  disposed: boolean;
};

/**
 * The daemon's one ace-files: started on first use, never on startup, and killed with the daemon.
 * Roots, listings and quick open go through it; a machine without the binary keeps every other
 * file feature working, and the ones that need it fail with a retryable error.
 */
export class FilesTool {
  readonly #binary: string | undefined;
  readonly #host: FilesHost;
  readonly #clock: FilesClock;
  readonly #log: FilesLog;
  readonly #idleMs: number | undefined;
  readonly #watches = new Map<string, RootWatch>();
  #process: FilesProcess | undefined;
  #client: FilesClient | undefined;
  #roots: FilesRoots | undefined;
  #starting: Promise<void> | undefined;
  #closed = false;

  constructor(options: FilesToolOptions) {
    this.#binary = options.binary;
    this.#host = options.host ?? nodeFilesHost(process.env);
    this.#clock = options.clock ?? systemFilesClock;
    this.#log = options.log ?? (() => {});
    this.#idleMs = options.idleMs;
  }

  /** True when this install carries ace-files at all. */
  get available(): boolean {
    return this.#binary !== undefined;
  }

  /**
   * Open a checkout nobody asked to list yet, so its index is warm before the first quick open.
   * Best effort: a machine without ace-files, or a folder that vanished, simply does not warm.
   */
  async warm(path: string): Promise<void> {
    try {
      await this.client();
      await this.#rootBook().use(path, () => Promise.resolve());
    } catch (error) {
      this.#log("debug", "Could not warm a checkout for ace-files", {
        path,
        error: String(error),
      });
    }
  }

  /** The folder ace-files would call a root, with missing folders as `NOT_FOUND`. */
  async canonical(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch (error) {
      const code =
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
          ? "NOT_FOUND"
          : "IO_ERROR";
      throw new FilesRequestError(code, `cannot open ${path}: ${message(error)}`);
    }
  }

  /** Start ace-files unless it runs, and resolve with the client once it answers `hello`. */
  async client(): Promise<FilesClient> {
    if (this.#closed) throw new FilesRequestError("CANCELLED", "ace-files was disposed");
    if (!this.#binary) throw aceFilesMissing();
    if (!this.#client) {
      const process = new FilesProcess({
        binary: this.#binary,
        host: this.#host,
        clock: this.#clock,
        log: this.#log,
      });
      this.#process = process;
      this.#client = new FilesClient(process);
      const roots = new FilesRoots(
        {
          canonicalize: (path) => this.canonical(path),
          open: async (path) => process.openRoot(path),
          close: async (root) => process.closeRoot(root),
          now: () => this.#clock.now(),
        },
        this.#idleMs,
      );
      this.#roots = roots;
      this.#starting = process.start().then(
        () => {
          this.#starting = undefined;
        },
        (error: unknown) => {
          // The supervisor keeps restarting in the background; a later call waits on it again.
          this.#starting = undefined;
          throw error;
        },
      );
    }
    await this.#starting;
    const client = this.#client;
    if (!client) throw aceFilesMissing();
    return client;
  }

  /** One folder of a checkout, paged, from ace-files. */
  async listFolder(
    path: string,
    dir: string,
    options: { limit?: number | undefined; cursor?: string | undefined } = {},
  ): Promise<FolderPage> {
    const client = await this.client();
    const page = await this.#rootBook().use(path, (root) =>
      client.list(root, dir, {
        limit: options.limit ?? filesListDefaults.limit,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      }),
    );
    return folderPage(page);
  }

  /**
   * Quick-open paths from the checkout's index. Undefined while the index is still building or
   * ace-files cannot answer, which leaves the caller its existing answer instead of no answer.
   */
  async quickOpen(path: string, query: string, limit: number): Promise<string[] | undefined> {
    try {
      const client = await this.client();
      const answer = await this.#rootBook().use(path, (root) =>
        client.indexQuery(root, query, limit),
      );
      return answer.ready ? answer.hits.map((hit) => hit.path) : undefined;
    } catch (error) {
      this.#log("debug", "Quick open fell back to the TypeScript index", { error: String(error) });
      return undefined;
    }
  }

  /**
   * Watch a checkout's whole tree; every caller on the same checkout shares one ace-files watch.
   * The returned function stops this listener; the watch itself stops with its last listener.
   */
  async watch(
    path: string,
    onBatch: (payload: EventPayload) => void,
  ): Promise<() => Promise<void>> {
    const canonical = await this.canonical(path);
    let entry = this.#watches.get(canonical);
    if (!entry) {
      entry = { listeners: new Set(), closed: false, disposed: false };
      this.#watches.set(canonical, entry);
    }
    entry.listeners.add(onBatch);
    try {
      await this.#subscribe(canonical, entry);
    } catch (error) {
      entry.listeners.delete(onBatch);
      await this.#dropIfIdle(canonical, entry);
      throw error;
    }
    const watch = entry;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      watch.listeners.delete(onBatch);
      await this.#dropIfIdle(canonical, watch);
    };
  }

  /** Close roots nobody held for the idle window; returns the folders that closed. */
  sweep(): Promise<string[]> {
    return this.#roots?.sweep() ?? Promise.resolve([]);
  }

  /** Kill ace-files and drop every root and watch; the daemon is going away. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#watches.values()) {
      entry.closed = true;
      await this.#dispose(entry);
    }
    this.#watches.clear();
    this.#process?.dispose();
    this.#process = undefined;
    this.#client = undefined;
    this.#roots = undefined;
  }

  async #subscribe(canonical: string, entry: RootWatch): Promise<void> {
    entry.starting ??= this.#startWatch(canonical, entry).finally(() => {
      entry.starting = undefined;
    });
    await entry.starting;
  }

  async #startWatch(canonical: string, entry: RootWatch): Promise<void> {
    const hold = await this.#rootBook().hold(canonical);
    try {
      const client = await this.client();
      const subscription = await client.watch(hold.root, (payload) => {
        for (const listener of entry.listeners) {
          try {
            listener(payload);
          } catch (error) {
            this.#log("warn", "A folder-watch listener failed", { error: String(error) });
          }
        }
      });
      entry.hold = hold;
      entry.subscription = subscription;
      if (entry.closed) await this.#dispose(entry);
    } catch (error) {
      hold.release();
      throw error;
    }
  }

  async #dropIfIdle(canonical: string, entry: RootWatch): Promise<void> {
    if (entry.listeners.size > 0 || entry.closed) return;
    entry.closed = true;
    if (this.#watches.get(canonical) === entry) this.#watches.delete(canonical);
    // A watch still starting disposes itself once its subscription arrives.
    if (entry.starting) return;
    await this.#dispose(entry);
  }

  async #dispose(entry: RootWatch): Promise<void> {
    if (entry.disposed) return;
    entry.disposed = true;
    const subscription = entry.subscription;
    entry.subscription = undefined;
    entry.hold?.release();
    entry.hold = undefined;
    if (!subscription) return;
    try {
      await subscription.dispose();
    } catch (error) {
      this.#log("debug", "ace-files did not take its unwatch", { error: String(error) });
    }
  }

  /** The root book, which exists from the moment the process does. */
  #rootBook(): FilesRoots {
    const roots = this.#roots;
    if (!roots) throw new FilesRequestError("FILES_RESTARTING", "ace-files is not running");
    return roots;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
