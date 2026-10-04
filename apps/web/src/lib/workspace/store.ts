import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import type { WorkspaceDefinition } from "./definition.ts";
import {
  emptyWorkspace,
  seedWorkspace,
  sanitize,
  ScopeWorkspaceSchema,
  type Dock,
  type ScopeWorkspace,
} from "./model.ts";

/*
 * Where the workspace lives at runtime: each scope's (thread's) docks and tabs, the preferred
 * dock sizes new scopes start at, and which scope's screen is showing. Plain local UI state,
 * persisted to the injected storage; never daemon state.
 *
 * Bounded: the most recently changed `capacity` scopes are kept, the rest forgotten (they start
 * again from their definition's initial tabs).
 */

export interface PreferredSizes {
  right: number;
  bottom: number;
}
export const defaultSizes: PreferredSizes = { right: 520, bottom: 240 };

const storageKey = "ace.workspace";
/** The shell layout's old single panel state (before per-thread workspaces); sizes carry over. */
const legacyKey = "ace.layout";

const Persisted = z.object({
  preferred: z.object({ right: z.number(), bottom: z.number() }),
  scopes: z.array(z.tuple([z.string(), ScopeWorkspaceSchema])),
});
const Legacy = z.object({
  right: z.optional(z.object({ size: z.number() })),
  bottom: z.optional(z.object({ size: z.number() })),
});

export class WorkspaceStore {
  private readonly storage: KeyValueStorage | undefined;
  private readonly capacity: number;
  /** Insertion order is recency: the last entry changed most recently. */
  private readonly scopes = new Map<string, ScopeWorkspace>();
  /** Scopes seeded from a definition but never changed: shown, not persisted. */
  private readonly seeded = new Set<string>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly globalListeners = new Set<() => void>();
  private preferredSizes: PreferredSizes;
  private focusedScope: string | undefined;
  /** A change was kept in memory only (a drag still moving); the next persist writes it. */
  private dirty = false;
  private readonly definitions = new Map<string, WorkspaceDefinition>();

  constructor(options: { storage?: KeyValueStorage | undefined; capacity?: number } = {}) {
    this.storage = options.storage;
    this.capacity = options.capacity ?? 64;
    const stored = readJson(this.storage, storageKey, Persisted, undefined);
    if (stored) {
      this.preferredSizes = stored.preferred;
      for (const [scope, workspace] of stored.scopes.slice(-this.capacity))
        this.scopes.set(scope, sanitize(workspace));
    } else {
      const legacy = readJson(this.storage, legacyKey, Legacy, {});
      this.preferredSizes = {
        right: legacy.right?.size ?? defaultSizes.right,
        bottom: legacy.bottom?.size ?? defaultSizes.bottom,
      };
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
   * exist, which docks they go to and what a fresh scope starts with. Seeds the scope.
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

  get preferred(): PreferredSizes {
    return this.preferredSizes;
  }

  /** The size scopes without one of their own use; set by the last resize anywhere. */
  setPreferred(dock: Dock, size: number, persist = true): void {
    const rounded = Math.round(size);
    if (this.preferredSizes[dock] !== rounded) {
      this.preferredSizes = { ...this.preferredSizes, [dock]: rounded };
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

  subscribe(scope: string, listener: () => void): () => void {
    let set = this.listeners.get(scope);
    if (!set) this.listeners.set(scope, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(scope);
    };
  }

  /** Preferred sizes and the focused scope. */
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
    }
  }

  private save() {
    this.dirty = false;
    const scopes = [...this.scopes].filter(([scope]) => !this.seeded.has(scope));
    writeJson(this.storage, storageKey, { preferred: this.preferredSizes, scopes });
  }
}
