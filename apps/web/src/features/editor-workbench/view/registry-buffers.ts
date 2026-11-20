import type { ProviderKind } from "@ace/protocol";
import { groupsOf, type EditorLayout } from "@ace/ui-core/editor-workbench";
import { useEffect, useMemo } from "react";
import type { Author } from "../buffers/attribution.ts";
import type { BufferRegistry } from "../buffers/registry.ts";
import type { BufferLease, BufferSnapshot, TextBuffer } from "../buffers/types.ts";
import { unknownFacts, type BufferChanger, type BufferFacts, type DeckBuffers } from "./buffers.ts";

/*
 * The Deck's tie to W2's buffer registry for one checkout: a lease per open path (spec 56:
 * buffers are reference-counted by tabs), each group's active path marked visible (only those
 * are kept from eviction and render), and the registry's snapshots turned into the facts the
 * view draws.
 */

export interface RegistryBuffers extends DeckBuffers {
  /** Hold the paths the layout has open; let go of the rest. */
  sync(layout: EditorLayout): void;
  /** The shared buffer behind a path, for the editor view, save, Merge and Compare. */
  buffer(path: string): TextBuffer | undefined;
  dispose(): void;
}

export interface RegistryBuffersOptions {
  /** The provider whose mark stands for an agent's name, when there is one. */
  providerOf?: ((agent: string) => ProviderKind | undefined) | undefined;
}

interface Held {
  lease: BufferLease;
  unsubscribe(): void;
  snapshot: BufferSnapshot | undefined;
  facts: BufferFacts;
}

export function registryBuffers(
  registry: BufferRegistry,
  root: string,
  options: RegistryBuffersOptions = {},
): RegistryBuffers {
  const held = new Map<string, Held>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const refresh = (entry: Held) => {
    const snapshot = entry.lease.buffer.snapshot();
    if (snapshot === entry.snapshot) return false;
    entry.snapshot = snapshot;
    entry.facts = factsOf(snapshot, options.providerOf);
    return true;
  };
  return {
    facts: (path) => held.get(path)?.facts ?? unknownFacts,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    buffer: (path) => held.get(path)?.lease.buffer,
    sync: (layout) => {
      const groups = groupsOf(layout);
      const open = new Set(groups.flatMap((group) => group.tabs.map((tab) => tab.path)));
      const visible = new Set(groups.flatMap((group) => (group.active ? [group.active] : [])));
      let changed = false;
      for (const [path, entry] of held) {
        if (open.has(path)) continue;
        entry.unsubscribe();
        entry.lease.release();
        held.delete(path);
        changed = true;
      }
      for (const path of open) {
        let entry = held.get(path);
        if (!entry) {
          const lease = registry.open({ root, path });
          const created: Held = {
            lease,
            unsubscribe: () => {},
            snapshot: undefined,
            facts: unknownFacts,
          };
          created.unsubscribe = lease.buffer.subscribe(() => {
            if (refresh(created)) notify();
          });
          held.set(path, created);
          entry = created;
          changed = refresh(created) || changed;
        }
        entry.lease.setVisible(visible.has(path));
      }
      if (changed) notify();
    },
    dispose: () => {
      for (const entry of held.values()) {
        entry.unsubscribe();
        entry.lease.release();
      }
      held.clear();
    },
  };
}

/** The view's facts from one registry snapshot. */
export function factsOf(
  snapshot: BufferSnapshot,
  providerOf?: (agent: string) => ProviderKind | undefined,
): BufferFacts {
  const { status, clash } = snapshot;
  const load: BufferFacts["load"] =
    status.kind === "ready"
      ? { state: "ready" }
      : status.kind === "missing"
        ? { state: "deleted", restorable: false }
        : status.kind === "unreadable"
          ? { state: "unreadable", reason: status.reason }
          : status.kind === "failed"
            ? { state: "unreadable", reason: status.message }
            : // Loading, or freed under the memory cap and reading again now it is shown.
              { state: "loading" };
  // A deleted-on-disk clash is no Merge: the buffer saves the file back (W2's rule).
  const merging = clash?.kind === "merging";
  const notice = clash && clash.kind !== "deleted" ? { merging } : undefined;
  return {
    load,
    unsaved: snapshot.dirty,
    clash: notice,
    changedBy: clash ? changer(clash.by, providerOf) : undefined,
    // Unseen-change marks come with the editor's change bars (spec 43); the registry has none yet.
    unseenAgentChange: false,
  };
}

function changer(
  author: Author,
  providerOf?: (agent: string) => ProviderKind | undefined,
): BufferChanger | undefined {
  if (author.kind === "unknown") return undefined;
  const name = author.kind === "agent" ? author.agent : author.title;
  return { name, provider: providerOf?.(author.agent) };
}

/**
 * A component's registry bridge for one checkout: synced to its layout, released on unmount.
 * `providerOf` should be stable (module-level); a new one makes a new bridge.
 */
export function useRegistryBuffers(
  registry: BufferRegistry,
  root: string,
  layout: EditorLayout,
  providerOf?: (agent: string) => ProviderKind | undefined,
): RegistryBuffers {
  const bridge = useMemo(
    () => registryBuffers(registry, root, { providerOf }),
    [registry, root, providerOf],
  );
  useEffect(() => () => bridge.dispose(), [bridge]);
  useEffect(() => bridge.sync(layout), [bridge, layout]);
  return bridge;
}
