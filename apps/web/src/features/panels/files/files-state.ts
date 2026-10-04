import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { useCallback, useSyncExternalStore } from "react";
import { useLayout } from "@/lib/layout.tsx";
import type { WorkspaceTab } from "@/lib/workspace/index.ts";
import { useScopedRecent, useScopedRecentStore, type ScopedRecent } from "../recent-store.ts";

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

const prefsKey = "ace.files.prefs";
const defaultPrefs: FilePrefs = { treeOpen: true, treeWidth: 240, wrap: false };

export class FilesMemory {
  private storage: KeyValueStorage | undefined;
  private listeners = new Set<() => void>();
  prefs: FilePrefs;
  constructor(storage: KeyValueStorage | undefined) {
    this.storage = storage;
    this.prefs = readJson(storage, prefsKey, Prefs, defaultPrefs);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private changed() {
    for (const listener of this.listeners) listener();
  }
  setPrefs(patch: Partial<FilePrefs>, persist = true) {
    this.prefs = { ...this.prefs, ...patch };
    if (persist) writeJson(this.storage, prefsKey, this.prefs);
    this.changed();
  }
}

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

/** Files each thread opened recently, kept on this device. */
const recentFiles = { key: "ace.files.recent", perScope: 20, scopes: 64 };

export function useRecentFilesStore(): ScopedRecent {
  return useScopedRecentStore(recentFiles);
}

export function useRecentFiles(threadId: string): readonly string[] {
  return useScopedRecent(useRecentFilesStore(), threadId);
}
