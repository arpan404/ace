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
import type { KeptValue } from "./kept-value.ts";

/*
 * The phone's stand-in for file tabs: per thread (or project folder), the files opened recently
 * and the files left open, in order, closable, kept on this device between launches
 * (`keptValue("files")`). Each change answers with the scope's `files.memory` patch.
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
  #recent: ScopedLists = [];
  #open: ScopedLists = [];
  #loaded: Promise<void> | undefined;
  #saving: Promise<void> = Promise.resolve();
  constructor(kept: KeptValue, sink: Pick<PatchSink, "put">) {
    this.#kept = kept;
    this.#sink = sink;
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
        this.#open = putScoped(this.#open, key, moveInList(open, action.from, action.to), openLimits);
        break;
      case "files.forgot":
        this.#recent = putScoped(this.#recent, key, closeInList(recent, action.path), recentLimits);
        this.#open = putScoped(this.#open, key, closeInList(open, action.path), openLimits);
        break;
    }
    this.#show(action.scope);
    this.#save();
  }

  #load(): Promise<void> {
    this.#loaded ??= this.#kept.load().then((value) => {
      const kept = Kept.safeParse(value ?? {});
      if (!kept.success) return;
      this.#recent = kept.data.recent.slice(0, recentLimits.scopes);
      this.#open = kept.data.open.slice(0, openLimits.scopes);
    });
    return this.#loaded;
  }

  /** Saves in order, each the latest lists; a failed save is tried again with the next change. */
  #save() {
    // The host keeps at most 1 MiB: the least recently used scopes go first.
    while (
      JSON.stringify({ recent: this.#recent, open: this.#open }).length > keptBytes &&
      (this.#recent.length || this.#open.length)
    ) {
      this.#recent = this.#recent.slice(0, -1);
      this.#open = this.#open.slice(0, -1);
    }
    const value = { recent: this.#recent, open: this.#open };
    this.#saving = this.#saving.then(() => this.#kept.save(value)).catch(() => {});
  }

  #show(scope: FilesScope) {
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
