import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import type { WorkspaceDefinition } from "./definition.ts";
import type { CloseWarning } from "./registry.ts";
import {
  emptyWorkspace,
  seedWorkspace,
  sanitize,
  ScopeWorkspaceSchema,
  type ScopeWorkspace,
  type WorkspaceTab,
} from "./model.ts";

/*
 * Where the workspace lives at runtime: each scope's (thread's) side panel and tabs, the
 * preferred panel width new scopes start at, and which scope's screen is showing. Plain local UI state,
 * persisted to the injected storage; never daemon state.
 *
 * Bounded: the most recently changed `capacity` scopes are kept, the rest forgotten (they start
 * again from their definition's initial tabs).
 */

/** The side panel's width a scope without one of its own starts at. */
export const defaultSize = 520;

/** A closed tab, kept so Reopen closed tab can put it back where it was. */
export interface ClosedTab {
  tab: WorkspaceTab;
  index: number;
}
/** Closed tabs kept per scope. */
const closedCapacity = 10;

const storageKey = "ace.workspace";
/** The shell layout's old single panel state (before per-thread workspaces); sizes carry over. */
const legacyKey = "ace.layout";

// `preferred` keeps its object shape (once `{ right, bottom }`, the bottom panel's now ignored).
const Persisted = z.object({
  preferred: z.object({ right: z.number() }),
  scopes: z.array(z.tuple([z.string(), ScopeWorkspaceSchema])),
});
const Legacy = z.object({ right: z.optional(z.object({ size: z.number() })) });

export class WorkspaceStore {
  private readonly storage: KeyValueStorage | undefined;
  private readonly capacity: number;
  /** Insertion order is recency: the last entry changed most recently. */
  private readonly scopes = new Map<string, ScopeWorkspace>();
  /** Scopes seeded from a definition but never changed: shown, not persisted. */
  private readonly seeded = new Set<string>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly globalListeners = new Set<() => void>();
  private preferredSize: number;
  private focusedScope: string | undefined;
  /** A change was kept in memory only (a drag still moving); the next persist writes it. */
  private dirty = false;
  private readonly definitions = new Map<string, WorkspaceDefinition>();
  /** Per scope, the tabs closed most recently, newest last. Memory only. */
  private readonly closed = new Map<string, ClosedTab[]>();
  private confirmer: ((warning: CloseWarning) => Promise<boolean>) | undefined;
  /** Questions asked while no dialog was registered. */
  private readonly unasked: { warning: CloseWarning; answer(agreed: boolean): void }[] = [];

  constructor(options: { storage?: KeyValueStorage | undefined; capacity?: number } = {}) {
    this.storage = options.storage;
    this.capacity = options.capacity ?? 64;
    const stored = readJson(this.storage, storageKey, Persisted, undefined);
    if (stored) {
      this.preferredSize = stored.preferred.right;
      for (const [scope, workspace] of stored.scopes.slice(-this.capacity))
        this.scopes.set(scope, sanitize(workspace));
    } else {
      const legacy = readJson(this.storage, legacyKey, Legacy, {});
      this.preferredSize = legacy.right?.size ?? defaultSize;
    }
  }

  /** The scope's workspace; a scope never seen starts from `initial` (not persisted yet). */
  get(scope: string, initial?: () => ScopeWorkspace): ScopeWorkspace {
    const current = this.scopes.get(scope);
    if (current) return current;
    if (!initial) return emptyWorkspace;
    const seeded = initial();
    this.scopes.set(scope, seeded);
    this.seeded.add(scope);
    this.trim();
    return seeded;
  }

  /**
   * Bind a scope to its definition (the screen showing it does, on every render): which kinds
   * exist and what a fresh scope starts with. Seeds the scope.
   */
  define(scope: string, definition: WorkspaceDefinition): ScopeWorkspace {
    this.definitions.set(scope, definition);
    return this.get(scope, () => seedWorkspace(definition.initial));
  }

  definition(scope: string): WorkspaceDefinition | undefined {
    return this.definitions.get(scope);
  }

  /**
   * Change a scope's workspace. `persist: false` while a drag is still moving (the drag's end
   * persists), so storage is written once per gesture.
   */
  update(
    scope: string,
    change: (workspace: ScopeWorkspace) => ScopeWorkspace,
    options: { persist?: boolean } = {},
  ): void {
    const previous = this.get(scope);
    const next = change(previous);
    const persist = options.persist ?? true;
    if (next === previous) {
      if (persist && !this.seeded.has(scope) && this.dirty) this.save();
      return;
    }
    this.scopes.delete(scope);
    this.scopes.set(scope, next);
    this.seeded.delete(scope);
    this.trim();
    if (persist) this.save();
    else this.dirty = true;
    this.emit(scope);
  }

  get preferred(): number {
    return this.preferredSize;
  }

  /** The width scopes without one of their own use; set by the last resize anywhere. */
  setPreferred(size: number, persist = true): void {
    const rounded = Math.round(size);
    if (this.preferredSize !== rounded) {
      this.preferredSize = rounded;
      for (const listener of this.globalListeners) listener();
    }
    if (persist) this.save();
    else this.dirty = true;
  }

  /** The scope whose screen is showing, for global commands (palette, shortcuts). */
  get focused(): string | undefined {
    return this.focusedScope;
  }

  setFocused(scope: string | undefined): void {
    if (this.focusedScope === scope) return;
    this.focusedScope = scope;
    for (const listener of this.globalListeners) listener();
  }

  /**
   * The dialog that asks before closing tabs that would stop something (the screen's). Without
   * one, such tabs close at once.
   */
  setConfirm(confirm: (warning: CloseWarning) => Promise<boolean>): () => void {
    this.confirmer = confirm;
    // Questions asked before the dialog had loaded are asked now.
    for (const { warning, answer } of this.unasked.splice(0)) void confirm(warning).then(answer);
    return () => {
      if (this.confirmer === confirm) this.confirmer = undefined;
    };
  }

  /**
   * Ask whether to close tabs that would stop something. With no dialog yet, the question waits
   * for one rather than answering yes: closing never ends a shell unasked.
   */
  confirmClose(warning: CloseWarning): Promise<boolean> {
    if (this.confirmer) return this.confirmer(warning);
    return new Promise((answer) => this.unasked.push({ warning, answer }));
  }

  /** Keep a closed tab for Reopen closed tab (the last `closedCapacity` per scope). */
  rememberClosed(scope: string, closed: ClosedTab): void {
    const list = this.closed.get(scope) ?? [];
    list.push(closed);
    if (list.length > closedCapacity) list.shift();
    this.closed.set(scope, list);
  }

  /** The most recently closed tab of a scope that `accept` lets come back, forgetting it. */
  takeClosed(scope: string, accept: (closed: ClosedTab) => boolean): ClosedTab | undefined {
    const list = this.closed.get(scope) ?? [];
    for (let closed = list.pop(); closed; closed = list.pop()) if (accept(closed)) return closed;
    return undefined;
  }

  /** Whether the scope has a closed tab to reopen. */
  hasClosed(scope: string): boolean {
    return !!this.closed.get(scope)?.length;
  }

  subscribe(scope: string, listener: () => void): () => void {
    let set = this.listeners.get(scope);
    if (!set) this.listeners.set(scope, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(scope);
    };
  }

  /** The preferred width and the focused scope. */
  subscribeGlobal(listener: () => void): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  private emit(scope: string) {
    for (const listener of this.listeners.get(scope) ?? []) listener();
  }

  private trim() {
    for (const scope of this.scopes.keys()) {
      if (this.scopes.size <= this.capacity) break;
      if (scope === this.focusedScope) continue;
      this.scopes.delete(scope);
      this.seeded.delete(scope);
      this.definitions.delete(scope);
      this.closed.delete(scope);
    }
  }

  private save() {
    this.dirty = false;
    const scopes = [...this.scopes].filter(([scope]) => !this.seeded.has(scope));
    writeJson(this.storage, storageKey, { preferred: { right: this.preferredSize }, scopes });
  }
}
