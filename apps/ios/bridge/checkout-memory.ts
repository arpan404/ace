import {
  closeInList,
  moveInList,
  openInList,
  putScoped,
  rememberScoped,
  scopedList,
  type ScopedLimits,
  type ScopedLists,
} from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import { FilesScope } from "./checkout-request.ts";
import { readKept, type KeptRead, type Timers } from "./kept-read.ts";
import type { KeptValue } from "./kept-value.ts";

/*
 * The phone's stand-in for file tabs: per thread (or project folder), the files opened recently
 * and the files left open, in order, closable, kept on this device between launches
 * (`keptValue("files")`). Each change answers with the scope's `files.memory` patch. A failed
 * read is tried again and nothing is saved until one succeeds, so it never wipes the lists;
 * changes made meanwhile apply at once and are merged in when the read lands.
 */

const path = z.string().min(1).max(4096);
export const NativeMemoryAction = z.discriminatedUnion("type", [
  /** A Files screen showing `scope`: its lists come back as a patch. */
  z.object({ type: z.literal("files.memory.watch"), scope: FilesScope }),
  /** A file was shown: first among recents, and open (kept in place if it already was). */
  z.object({ type: z.literal("files.opened"), scope: FilesScope, path }),
  /** Closed: the file, or with a folder path ("src/") everything inside it. */
  z.object({ type: z.literal("files.closed"), scope: FilesScope, path }),
  /** Close every open file but `keep` (none to close all). */
  z.object({ type: z.literal("files.closed.others"), scope: FilesScope, keep: path.optional() }),
  /** Renamed or moved on the host: entries at or inside `from` follow it to `to`. */
  z.object({ type: z.literal("files.moved"), scope: FilesScope, from: path, to: path }),
  /** Deleted on the host: closed, and dropped from recents. */
  z.object({ type: z.literal("files.forgot"), scope: FilesScope, path }),
]);
export type NativeMemoryAction = z.infer<typeof NativeMemoryAction>;

const recentLimits: ScopedLimits = { perScope: 20, scopes: 64 };
const openLimits: ScopedLimits = { perScope: 12, scopes: 64 };
/** Under the host's 1 MiB cap per kept value, leaving room for multi-byte characters. */
const keptBytes = 256 * 1024;
const Kept = z.object({
  recent: z.array(z.tuple([z.string(), z.array(z.string())])).catch([]),
  open: z.array(z.tuple([z.string(), z.array(z.string())])).catch([]),
});

/** One key per scope, so a thread and a project folder never share lists. */
export function memoryKey(scope: FilesScope): string {
  return "threadId" in scope ? `thread:${scope.threadId}` : `project:${scope.workspaceId}`;
}

export class CheckoutMemory {
  readonly #kept: KeptValue;
  readonly #sink: Pick<PatchSink, "put">;
  readonly #timers: Timers;
  #recent: ScopedLists = [];
  #open: ScopedLists = [];
  #reading: KeptRead | undefined;
  #saving: Promise<void> | undefined;
  #shown: FilesScope | undefined;
  constructor(kept: KeptValue, sink: Pick<PatchSink, "put">, timers: Timers) {
    this.#kept = kept;
    this.#sink = sink;
    this.#timers = timers;
  }

  /** The scope's recent files, newest first (quick open shows these with nothing typed). */
  async recent(scope: FilesScope): Promise<readonly string[]> {
    await this.#load();
    return scopedList(this.#recent, memoryKey(scope));
  }

  async handle(action: NativeMemoryAction): Promise<void> {
    await this.#load();
    const key = memoryKey(action.scope);
    const recent = scopedList(this.#recent, key);
    const open = scopedList(this.#open, key);
    switch (action.type) {
      case "files.memory.watch":
        this.#show(action.scope);
        return;
      case "files.opened":
        this.#recent = rememberScoped(this.#recent, key, action.path, recentLimits);
        this.#open = putScoped(
          this.#open,
          key,
          openInList(open, action.path, openLimits.perScope),
          openLimits,
        );
        break;
      case "files.closed":
        this.#open = putScoped(this.#open, key, closeInList(open, action.path), openLimits);
        break;
      case "files.closed.others":
        this.#open = putScoped(
          this.#open,
          key,
          action.keep && open.includes(action.keep) ? [action.keep] : [],
          openLimits,
        );
        break;
      case "files.moved":
        this.#recent = putScoped(
          this.#recent,
          key,
          moveInList(recent, action.from, action.to),
          recentLimits,
        );
        this.#open = putScoped(
          this.#open,
          key,
          moveInList(open, action.from, action.to),
          openLimits,
        );
        break;
      case "files.forgot":
        this.#recent = putScoped(this.#recent, key, closeInList(recent, action.path), recentLimits);
        this.#open = putScoped(this.#open, key, closeInList(open, action.path), openLimits);
        break;
    }
    this.#show(action.scope);
    this.#save();
  }

  /** Settles after the first read attempt; a failing read keeps retrying behind it. */
  #load(): Promise<void> {
    if (!this.#reading) {
      this.#reading = readKept(this.#kept, this.#timers, () => {});
      this.#saving = this.#reading.read.then((value) => this.#merge(value));
    }
    return this.#reading.tried;
  }

  /** What was kept, under the lists changed before it read (those are newer). */
  #merge(value: unknown): void {
    const kept = Kept.safeParse(value ?? {});
    if (!kept.success) return;
    const under = (mine: ScopedLists, theirs: ScopedLists, limit: number) => {
      const held = new Set(mine.map(([key]) => key));
      return [...mine, ...theirs.filter(([key]) => !held.has(key))].slice(0, limit);
    };
    this.#recent = under(this.#recent, kept.data.recent, recentLimits.scopes);
    this.#open = under(this.#open, kept.data.open, openLimits.scopes);
    if (this.#shown) this.#show(this.#shown);
  }

  /** Saves in order, each the latest lists, never before the kept lists are read. */
  #save() {
    // Each save writes the lists as they are when it runs, so a read landing first is kept.
    this.#saving = (this.#saving ?? Promise.resolve())
      .then(() => this.#kept.save(this.#fitted()))
      .catch(() => {});
  }

  /** The lists within the host's 1 MiB: the least recently used scopes go first. */
  #fitted() {
    while (
      JSON.stringify({ recent: this.#recent, open: this.#open }).length > keptBytes &&
      (this.#recent.length || this.#open.length)
    ) {
      this.#recent = this.#recent.slice(0, -1);
      this.#open = this.#open.slice(0, -1);
    }
    return { recent: this.#recent, open: this.#open };
  }

  #show(scope: FilesScope) {
    this.#shown = scope;
    const key = memoryKey(scope);
    const recent = scopedList(this.#recent, key);
    const open = scopedList(this.#open, key);
    this.#sink.put(`files.memory:${key}`, () => ({
      type: "files.memory",
      key,
      scope,
      recent: [...recent],
      open: [...open],
    }));
  }
}
