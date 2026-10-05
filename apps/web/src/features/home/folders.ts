import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { useState, useSyncExternalStore } from "react";
import * as z from "zod/mini";
import { useLayout } from "@/lib/layout.tsx";

/*
 * Which project folders in the Home list are closed (kept on this device across reloads) and
 * which show all their threads past the first few (for this visit of the list only).
 */

const key = "ace.home.folders";
const Stored = z.object({ closed: z.catch(z.array(z.string()), []) });
/** Closed folders remembered, newest last: projects come and go, the list stays bounded. */
const keepClosed = 200;

export interface FolderState {
  closed: ReadonlySet<string>;
  showingAll: ReadonlySet<string>;
}

export class Folders {
  private state: FolderState;
  private listeners = new Set<() => void>();
  private storage: KeyValueStorage | undefined;
  constructor(storage: KeyValueStorage | undefined) {
    this.storage = storage;
    const stored = readJson(storage, key, Stored, { closed: [] });
    this.state = { closed: new Set(stored.closed.slice(-keepClosed)), showingAll: new Set() };
  }
  getState = (): FolderState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  toggleOpen(project: string): void {
    // A Set keeps insertion order, so the newest closings are last and the oldest drop first.
    const closed = [...this.state.closed].filter((id) => id !== project);
    if (!this.state.closed.has(project)) closed.push(project);
    const kept = closed.slice(-keepClosed);
    this.state = { ...this.state, closed: new Set(kept) };
    writeJson(this.storage, key, { closed: kept });
    this.emit();
  }
  toggleShowingAll(project: string): void {
    const showingAll = new Set(this.state.showingAll);
    if (showingAll.has(project)) showingAll.delete(project);
    else showingAll.add(project);
    this.state = { ...this.state, showingAll };
    this.emit();
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
}

/** The Home list's folders: one store per mounted list, read from this device's storage. */
export function useFolders(): { state: FolderState; folders: Folders } {
  const { storage } = useLayout();
  const [folders] = useState(() => new Folders(storage));
  const state = useSyncExternalStore(folders.subscribe, folders.getState, folders.getState);
  return { state, folders };
}
