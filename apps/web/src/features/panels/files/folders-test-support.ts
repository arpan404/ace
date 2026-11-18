import type { ClientApi } from "@ace/client";
import {
  FileOperation,
  FilesClientMessage,
  FilesServerMessage,
  type FolderPage,
  ThreadId,
  type FolderEntry,
  type ServerMessage,
} from "@ace/protocol";
import { z } from "zod";

/*
 * `list.folder` and `files.folders_changed` for web tests, at the app's client boundary: the
 * daemon's own wiring is out of this feature's hands, so a test answers the folder requests from
 * the fake daemon's bounded `list` (which stays right through file operations) and pushes
 * change notices itself. Everything else reaches the fake daemon unchanged.
 */

const FolderRequest = z.object({
  type: z.literal("files.request"),
  requestId: z.string().optional(),
  threadId: ThreadId,
  operation: FileOperation,
});
const Listing = z.object({ paths: z.array(z.string()), truncated: z.boolean() });
const ListingReply = z.object({
  type: z.literal("files.result"),
  requestId: z.string(),
  value: Listing,
});

export interface FolderRequestRecord {
  /** The folder asked for, without a trailing slash ("" is the root). */
  path: string;
  cursor: string | undefined;
  /** How many entries the page asked for. */
  limit: number;
}

export interface FolderFixture {
  /** Every `list.folder` the app sent, in order. */
  readonly requests: readonly FolderRequestRecord[];
  /** Every `files.watch`, in order: the folders it named ("" is the root). */
  readonly watches: readonly (readonly string[])[];
  /** How many times `folder` was listed ("src" or "src/" both mean src). */
  count(folder: string): number;
  /** Mark paths gitignored, so their rows carry `ignored: true`. */
  ignore(paths: readonly string[]): void;
  /** Push the daemon's `files.folders_changed` for this thread. */
  changed(folders: readonly string[], rescan?: boolean): void;
  /** Push the daemon's `files.changed` for one path, as an agent's write does. */
  changedFile(path: string): void;
  /** Hold the next listing of `folder` until the returned function is called. */
  hold(folder: string): () => void;
  /** Fail the next listing of `folder` with `code`. */
  failNext(folder: string, code: string): void;
}

const clean = (path: string) => path.replace(/\/+$/, "");
const isFolder = (entry: FolderEntry) => entry.kind === "directory";
const byName = (a: FolderEntry, b: FolderEntry) => {
  if (isFolder(a) !== isFolder(b)) return isFolder(a) ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
};

/**
 * Answers the lazy tree's folder requests from the fake daemon's checkout: `app.daemon` seeds
 * and mutates the files, this fixture only pages them one folder at a time.
 */
export function folderFixture(client: ClientApi, thread: string): FolderFixture {
  const threadId = ThreadId.parse(thread);
  const ignored = new Set<string>();
  const requests: FolderRequestRecord[] = [];
  const watches: string[][] = [];
  const listeners = new Set<(message: ServerMessage) => void>();
  const holds = new Map<string, Promise<void>>();
  const failures = new Map<string, string[]>();
  let changes = 0;

  type Patchable = {
    request(input: unknown, options?: unknown): Promise<unknown>;
    send(message: unknown): void;
    onMessage(listener: (message: ServerMessage) => void): () => void;
  };
  const patched = client as unknown as Patchable;
  const request = patched.request.bind(patched);
  const send = patched.send.bind(patched);
  // The app's own listeners keep hearing the fake daemon: one forwarder feeds them all.
  patched.onMessage((message) => {
    for (const listener of listeners) listener(message);
  });

  patched.onMessage = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const allPaths = async (): Promise<string[]> => {
    const reply = await request({
      type: "files.request",
      threadId,
      operation: { op: "list", path: "", limit: 1000 },
    });
    const parsed = ListingReply.safeParse(reply);
    return parsed.success ? parsed.data.value.paths : [];
  };

  const entriesOf = (paths: readonly string[], folder: string): FolderEntry[] => {
    const prefix = folder ? `${folder}/` : "";
    const entries = new Map<string, FolderEntry>();
    for (const path of paths) {
      if (path === prefix || !path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (!name) continue;
      const entryPath = `${prefix}${name}`;
      entries.set(entryPath, {
        name,
        path: entryPath,
        kind: slash < 0 ? "file" : "directory",
        size: 0,
        mtimeMs: 0,
        ignored: ignored.has(entryPath),
      });
    }
    return [...entries.values()].toSorted(byName);
  };

  patched.request = async (input, options) => {
    const envelope = FolderRequest.safeParse(input);
    if (!envelope.success || envelope.data.threadId !== threadId) return request(input, options);
    const operation = envelope.data.operation;
    if (operation.op !== "list.folder") return request(input, options);
    const requestId = envelope.data.requestId ?? "fixture-list.folder";
    const folder = clean(operation.path);
    requests.push({ path: folder, cursor: operation.cursor, limit: operation.limit });
    const offset = operation.cursor === undefined ? 0 : Number(operation.cursor);
    if (!Number.isInteger(offset) || offset < 0)
      return {
        type: "files.error",
        requestId,
        code: "INVALID_CURSOR",
        message: "Folder cursor is stale",
      };
    // The entries are read when the listing starts, so a held reply carries what it saw then.
    const paths = await allPaths();
    const held = holds.get(folder);
    if (held) {
      holds.delete(folder);
      await held;
    }
    const failure = failures.get(folder)?.shift();
    if (failure)
      return { type: "files.error", requestId, code: failure, message: "Folder listing failed" };
    const entries = entriesOf(paths, folder);
    const page = entries.slice(offset, offset + operation.limit);
    const nextCursor = offset + page.length < entries.length ? String(offset + page.length) : null;
    const value: FolderPage = { entries: page, nextCursor, total: entries.length };
    return { type: "files.result", requestId, value };
  };

  patched.send = (message) => {
    const parsed = FilesClientMessage.safeParse(message);
    if (parsed.success && parsed.data.type === "files.watch" && parsed.data.threadId === threadId) {
      watches.push(parsed.data.folders);
      return;
    }
    send(message);
  };

  return {
    requests,
    watches,
    count(folder) {
      return requests.filter((each) => each.path === clean(folder)).length;
    },
    ignore(paths) {
      for (const path of paths) ignored.add(clean(path));
    },
    changed(folders, rescan = false) {
      const message = FilesServerMessage.parse({
        type: "files.folders_changed",
        threadId,
        folders,
        rescan,
      });
      for (const listener of listeners) listener(message);
    },
    changedFile(path) {
      const message = FilesServerMessage.parse({
        type: "files.changed",
        change: { id: `change-${++changes}`, op: "write", path, version: null },
      });
      for (const listener of listeners) listener(message);
    },
    hold(folder) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.set(clean(folder), gate);
      return () => {
        holds.delete(clean(folder));
        release();
      };
    },
    failNext(folder, code) {
      const key = clean(folder);
      failures.set(key, [...(failures.get(key) ?? []), code]);
    },
  };
}
