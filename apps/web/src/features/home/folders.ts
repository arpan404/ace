import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { useSyncExternalStore } from "react";
import * as z from "zod/mini";
import { useLayout } from "@/lib/layout.tsx";

/*
 * Which project folders in the Home list are closed (kept on this device across reloads) and
 * which show all their threads past the first few (for this visit only).
 */

const key = "ace.home.folders";
const Stored = z.object({ closed: z.catch(z.array(z.string()), []) });

export interface FolderState {
  closed: ReadonlySet<string>;
  showingAll: ReadonlySet<string>;
}

class Folders {
  private state: FolderState;
  private listeners = new Set<() => void>();
  private storage: KeyValueStorage | undefined;
  constructor(storage: KeyValueStorage | undefined) {
    this.storage = storage;
    const stored = readJson(storage, key, Stored, { closed: [] });
    this.state = { closed: new Set(stored.closed), showingAll: new Set() };
  }
  getState = (): FolderState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  toggleOpen(project: string): void {
    const closed = toggled(this.state.closed, project);
    this.state = { ...this.state, closed };
    writeJson(this.storage, key, { closed: [...closed] });
    this.emit();
  }
  toggleShowingAll(project: string): void {
    this.state = { ...this.state, showingAll: toggled(this.state.showingAll, project) };
    this.emit();
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
}

function toggled(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

// One per injected storage, so each app instance (and each test) has its own.
const stores = new WeakMap<KeyValueStorage, Folders>();
let unstored: Folders | undefined;

function foldersFor(storage: KeyValueStorage | undefined): Folders {
  if (!storage) return (unstored ??= new Folders(undefined));
  let folders = stores.get(storage);
  if (!folders) {
    folders = new Folders(storage);
    stores.set(storage, folders);
  }
  return folders;
}

export function useFolders(): { state: FolderState; folders: Folders } {
  const folders = foldersFor(useLayout().storage);
  const state = useSyncExternalStore(folders.subscribe, folders.getState, folders.getState);
  return { state, folders };
}
