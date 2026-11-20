import type { ProviderKind } from "@ace/protocol";
import { groupsOf, type EditorLayout } from "@ace/ui-core/editor-workbench";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type {
  Author,
  BufferLease,
  BufferRegistry,
  BufferSnapshot,
  TextBuffer,
} from "../buffers/index.ts";

/*
 * The Deck's hold on W2's buffer registry for one checkout: a lease per open path (spec 56:
 * buffers are reference-counted by tabs), each group's active path marked visible (kept from
 * eviction, rendered), and each buffer's snapshot cached until its next event, so views read it
 * through `useSyncExternalStore`.
 */

export interface DeckBuffers {
  /** The path's buffer state; undefined until the Deck holds the path. Stable between events. */
  snapshot(path: string): BufferSnapshot | undefined;
  /** The shared buffer behind a path: its view for `CodeEditor`, save, Merge and Compare. */
  buffer(path: string): TextBuffer | undefined;
  /** Called whenever any held path's snapshot changes. */
  subscribe(listener: () => void): () => void;
  /** Who to name for a disk change, and their mark; undefined when nobody can be named. */
  changer(author: Author): Changer | undefined;
  /** Hold the paths the layout has open; let go of the rest. */
  sync(layout: EditorLayout): void;
  dispose(): void;
}

export interface Changer {
  /** "Claude Code", or another thread's title ("Fix relay loop"). */
  name: string;
  provider: ProviderKind | undefined;
}

interface Held {
  lease: BufferLease;
  unsubscribe(): void;
  snapshot: BufferSnapshot;
}

export function deckBuffers(
  registry: BufferRegistry,
  root: string,
  providerOf?: (agent: string) => ProviderKind | undefined,
): DeckBuffers {
  const held = new Map<string, Held>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    snapshot: (path) => held.get(path)?.snapshot,
    buffer: (path) => held.get(path)?.lease.buffer,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    changer: (author) =>
      author.kind === "unknown"
        ? undefined
        : {
            name: author.kind === "agent" ? author.agent : author.title,
            provider: providerOf?.(author.agent),
          },
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
          const created: Held = { lease, unsubscribe: () => {}, snapshot: lease.buffer.snapshot() };
          created.unsubscribe = lease.buffer.subscribe(() => {
            created.snapshot = lease.buffer.snapshot();
            notify();
          });
          held.set(path, created);
          entry = created;
          changed = true;
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

/**
 * A component's Deck buffers for one checkout: synced to its layout, released on unmount.
 * `providerOf` should be stable (module-level); a new one makes new buffers.
 */
export function useDeckBuffers(
  registry: BufferRegistry,
  root: string,
  layout: EditorLayout,
  providerOf?: (agent: string) => ProviderKind | undefined,
): DeckBuffers {
  const buffers = useMemo(
    () => deckBuffers(registry, root, providerOf),
    [registry, root, providerOf],
  );
  useEffect(() => () => buffers.dispose(), [buffers]);
  useEffect(() => buffers.sync(layout), [buffers, layout]);
  return buffers;
}

export function useSnapshot(
  buffers: DeckBuffers,
  path: string | undefined,
): BufferSnapshot | undefined {
  return useSyncExternalStore(buffers.subscribe, () =>
    path === undefined ? undefined : buffers.snapshot(path),
  );
}

/**
 * Spec 46: the notice shows while the disk change waits for Merge (and while one runs). A
 * deletion saves the file back instead; overlapping blocks are answered inline in the editor.
 */
export function noticeClash(snapshot: BufferSnapshot | undefined) {
  const clash = snapshot?.clash;
  return clash?.kind === "changed" || clash?.kind === "merging" ? clash : undefined;
}
