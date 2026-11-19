import {
  FilesClient,
  FilesProcess,
  FilesRequestError,
  nodeFilesHost,
  systemFilesClock,
  type DescriptionReply,
  type EntryReply,
  type EventPayload,
  type FilesClock,
  type FilesHost,
  type FilesLog,
  type FilesWatch,
  type FingerprintReply,
  type IndexReply,
  type PageReply,
  type ReadReply,
  type VersionReply,
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

/** ace-files' caps: a listing page and a quick-open answer never ask for more. */
export const maxListFolderLimit = 5_000;
export const maxIndexQueryLimit = 1_000;

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

/** What the tool needs from ace-files; `FilesClient` is the real one, a test brings a fake. */
export type FilesToolClient = {
  start(): Promise<void>;
  dispose(): void;
  openRoot(path: string): Promise<number>;
  closeRoot(root: number): Promise<void>;
  list(
    root: number,
    dir: string,
    options: {
      limit?: number | undefined;
      cursor?: string | undefined;
      snapshot?: boolean | undefined;
      signal?: AbortSignal | undefined;
    },
  ): Promise<PageReply>;
  stat(root: number, path: string): Promise<EntryReply>;
  describe(
    root: number,
    path: string,
    options?: { signal?: AbortSignal | undefined; full?: boolean | undefined },
  ): Promise<DescriptionReply>;
  describeEntry(
    root: number,
    path: string,
    options?: { signal?: AbortSignal | undefined; internal?: boolean | undefined },
  ): Promise<DescriptionReply>;
  fingerprint(
    root: number,
    path: string,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<FingerprintReply>;
  measure(
    root: number,
    path: string,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<{ bytes: number; shallow: boolean }>;
  read(
    root: number,
    path: string,
    options?: {
      offset?: number | undefined;
      length?: number | undefined;
      maxSize?: number | undefined;
      signal?: AbortSignal | undefined;
    },
  ): Promise<{ meta: ReadReply; bytes: Uint8Array }>;
  write(
    root: number,
    path: string,
    bytes: Uint8Array,
    options?: { expected?: string | undefined; signal?: AbortSignal | undefined },
  ): Promise<VersionReply>;
  createFile(
    root: number,
    path: string,
    bytes: Uint8Array,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<VersionReply>;
  createDir(
    root: number,
    path: string,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<string | null>;
  rename(
    root: number,
    from: string,
    to: string,
    options?: {
      signal?: AbortSignal | undefined;
      expected?: string | undefined;
      own?: string | undefined;
      staging?: string | undefined;
    },
  ): Promise<{ version: string | null; identity: string | null; recovery: string | null }>;
  /** Park a client's entry at the generated trash endpoint, verified after the move. */
  trash(
    root: number,
    path: string,
    endpoint: string,
    expected: string,
    options?: { signal?: AbortSignal | undefined; own?: string | undefined },
  ): Promise<void>;
  /** Move a generated trash endpoint back to a client path that must be absent. */
  untrash(
    root: number,
    endpoint: string,
    path: string,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<{ version: string | null; identity: string | null; recovery: string | null }>;
  /** Finish a journaled case-only move from one of the daemon's own staging names. */
  recoverMove(
    root: number,
    from: string,
    to: string,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<{ version: string | null; identity: string | null; recovery: string | null }>;
  remove(root: number, path: string, options?: { signal?: AbortSignal | undefined }): Promise<void>;
  indexQuery(root: number, query: string, limit: number): Promise<IndexReply>;
  watch(root: number, onBatch: (payload: EventPayload) => void): Promise<FilesWatch>;
  /** Name the folders people have open on a root, which its watcher checks itself. */
  focus(root: number, folders: readonly string[]): Promise<void>;
};

export type FilesToolOptions = {
  /** The binary, or undefined when this install has none; looked up once per daemon. */
  binary: string | undefined;
  host?: FilesHost | undefined;
  clock?: FilesClock | undefined;
  log?: FilesLog | undefined;
  /** How long a root nobody holds stays open; the plan's ten minutes. */
  idleMs?: number | undefined;
  /** A prepared client instead of spawning the binary; tests use it. */
  open?: ((binary: string) => FilesToolClient) | undefined;
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
  readonly #open: ((binary: string) => FilesToolClient) | undefined;
  readonly #watches = new Map<string, RootWatch>();
  #client: FilesToolClient | undefined;
  #roots: FilesRoots | undefined;
  #starting: Promise<void> | undefined;
  #closed = false;

  constructor(options: FilesToolOptions) {
    this.#binary = options.binary;
    this.#host = options.host ?? nodeFilesHost(process.env);
    this.#clock = options.clock ?? systemFilesClock;
    this.#log = options.log ?? (() => {});
    this.#idleMs = options.idleMs;
    this.#open = options.open;
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
  async client(): Promise<FilesToolClient> {
    if (this.#closed) throw new FilesRequestError("CANCELLED", "ace-files was disposed");
    if (!this.#binary) throw aceFilesMissing();
    if (!this.#client) {
      const process =
        this.#open?.(this.#binary) ??
        new FilesClient(
          new FilesProcess({
            binary: this.#binary,
            host: this.#host,
            clock: this.#clock,
            log: this.#log,
          }),
        );
      this.#client = process;
      const client = process;
      const roots = new FilesRoots(
        {
          canonicalize: (path) => this.canonical(path),
          open: async (path) => client.openRoot(path),
          close: async (root) => client.closeRoot(root),
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

  /**
   * Run one task against a checkout's open root. The root is held for the task, so an idle sweep
   * never closes it underneath; a machine without ace-files fails here with `FILES_RESTARTING`.
   */
  async run<T>(
    path: string,
    task: (client: FilesToolClient, root: number) => Promise<T>,
  ): Promise<T> {
    const client = await this.client();
    return this.#rootBook().use(path, (root) => task(client, root));
  }

  /** One folder of a checkout, paged, from ace-files. */
  async listFolder(
    path: string,
    dir: string,
    options: {
      limit?: number | undefined;
      cursor?: string | undefined;
      /** Pin the listing for a multi-page traversal that must not fail on a changing folder. */
      snapshot?: boolean | undefined;
      signal?: AbortSignal | undefined;
    } = {},
  ): Promise<FolderPage> {
    const client = await this.client();
    const limit = Math.min(
      Math.max(1, options.limit ?? filesListDefaults.limit),
      maxListFolderLimit,
    );
    const page = await this.#rootBook().use(path, (root) =>
      client.list(root, dir, {
        limit,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );
    return folderPage(page);
  }

  /**
   * Quick-open paths from the checkout's index, files and folders together; a folder's path ends
   * in `/`. `ready: false` means the index is still building and the client keeps its loading
   * state; there is no TypeScript index to fall back to. No query is the shallowest paths.
   */
  async quickOpen(
    path: string,
    query: string,
    limit: number,
  ): Promise<{ paths: string[]; ready: boolean }> {
    const client = await this.client();
    const capped = Math.min(Math.max(1, Math.trunc(limit)), maxIndexQueryLimit);
    const answer = await this.#rootBook().use(path, (root) =>
      client.indexQuery(root, query, capped),
    );
    return {
      paths: answer.ready ? answer.hits.map((hit) => hit.path) : [],
      ready: answer.ready,
    };
  }

  /**
   * Watch a checkout's whole tree; every caller on the same checkout shares one ace-files watch.
   * The returned function stops this listener; the watch itself stops with its last listener.
   */
  /**
   * Name the folders people have open on a checkout, replacing the last set. Its watcher checks
   * them without waiting for the OS watch, which on a loaded Mac can be minutes late.
   */
  focus(path: string, folders: readonly string[]): Promise<void> {
    return this.run(path, (client, root) => client.focus(root, folders));
  }

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
    this.#client?.dispose();
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
    const client = await this.client();
    const hold = await this.#rootBook().hold(canonical);
    try {
      const subscription = await client.watch(hold.root, (payload) => {
        for (const listener of entry.listeners) {
          try {
            listener(payload);
          } catch (error) {
            this.#log("warn", "A folder-watch listener failed", { error: String(error) });
          }
        }
      });
      if (entry.disposed) {
        // The tool closed while this subscription was in flight: give it back directly.
        hold.release();
        try {
          await subscription.dispose();
        } catch (error) {
          this.#log("debug", "ace-files did not take its unwatch", { error: String(error) });
        }
        return;
      }
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
