import * as z from "zod/mini";
import { readJson, rememberRecent, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { useCallback, useSyncExternalStore } from "react";
import { useLayout } from "@/lib/layout.tsx";
import type { WorkspaceTab } from "@/lib/workspace/index.ts";

/*
 * The Files tool's local state: what a file tab holds (kept with the tab), the files each thread
 * opened recently, and this device's viewer preferences. Never daemon state.
 */

/** A file tab's data: the file it shows, and whether it is a preview a click may replace. */
export const FileTabData = z.object({
  path: z.optional(z.string()),
  /** Opened by a single click: the next file picked in its tree takes its place. */
  preview: z.optional(z.boolean()),
  /** Markdown shows rendered unless the person asked for its source. */
  source: z.optional(z.boolean()),
  /** Scroll to this line once shown (from quick open's `path:line`). */
  line: z.optional(z.number()),
});
export type FileTabData = z.infer<typeof FileTabData>;

/** A tab's data as the Files tool reads it; anything else (from storage) is an empty tab. */
export function fileTabData(tab: WorkspaceTab): FileTabData {
  const parsed = FileTabData.safeParse(tab.data);
  return parsed.success ? parsed.data : {};
}

const Prefs = z.object({
  treeOpen: z.catch(z.boolean(), true),
  treeWidth: z.catch(z.number(), 240),
  wrap: z.catch(z.boolean(), false),
});
export type FilePrefs = z.infer<typeof Prefs>;
const Recent = z.array(z.tuple([z.string(), z.array(z.string())]));

const prefsKey = "ace.files.prefs";
const recentKey = "ace.files.recent";
/** Threads whose recent files are kept, the most recently used first. */
const recentThreads = 64;
const defaultPrefs: FilePrefs = { treeOpen: true, treeWidth: 240, wrap: false };

export class FilesMemory {
  private storage: KeyValueStorage | undefined;
  private listeners = new Set<() => void>();
  private recent: ReadonlyMap<string, readonly string[]>;
  prefs: FilePrefs;
  constructor(storage: KeyValueStorage | undefined) {
    this.storage = storage;
    this.prefs = readJson(storage, prefsKey, Prefs, defaultPrefs);
    this.recent = new Map(readJson(storage, recentKey, Recent, []));
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private changed() {
    for (const listener of this.listeners) listener();
  }
  recentFiles(threadId: string): readonly string[] {
    return this.recent.get(threadId) ?? none;
  }
  remember(threadId: string, path: string) {
    const current = this.recentFiles(threadId);
    if (current[0] === path && this.recent.keys().next().value === threadId) return;
    const files = rememberRecent(current, path);
    const next = new Map([
      [threadId, files],
      ...[...this.recent].filter(([id]) => id !== threadId),
    ]);
    this.recent = new Map([...next].slice(0, recentThreads));
    writeJson(this.storage, recentKey, [...this.recent]);
    this.changed();
  }
  setPrefs(patch: Partial<FilePrefs>, persist = true) {
    this.prefs = { ...this.prefs, ...patch };
    if (persist) writeJson(this.storage, prefsKey, this.prefs);
    this.changed();
  }
}

const none: readonly string[] = [];
const memories = new WeakMap<object, FilesMemory>();
let withoutStorage: FilesMemory | undefined;

/** The Files tool's memory for this app's storage (one per `<LayoutProvider>` storage). */
export function useFilesMemory(): FilesMemory {
  const { storage } = useLayout();
  if (!storage) return (withoutStorage ??= new FilesMemory(undefined));
  let memory = memories.get(storage);
  if (!memory) {
    memory = new FilesMemory(storage);
    memories.set(storage, memory);
  }
  return memory;
}

export function useFilePrefs(): [FilePrefs, FilesMemory] {
  const memory = useFilesMemory();
  const read = useCallback(() => memory.prefs, [memory]);
  return [useSyncExternalStore(memory.subscribe, read, read), memory];
}

export function useRecentFiles(threadId: string): readonly string[] {
  const memory = useFilesMemory();
  const read = useCallback(() => memory.recentFiles(threadId), [memory, threadId]);
  return useSyncExternalStore(memory.subscribe, read, read);
}
