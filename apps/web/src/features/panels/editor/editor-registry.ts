import type { ClientApi } from "@ace/client";
import { ensureEditorReady } from "@/features/editor";
import {
  attribute,
  checkoutFiles,
  createBufferRegistry,
  deviceDrafts,
  workerMerge,
  type Author,
  type BufferKey,
  type BufferRegistry,
  type EditCall,
} from "@/features/editor-workbench/index.ts";
import { imageType } from "@ace/ui-core";
import { daemonCheckout, mediaOf } from "../files/checkout-source.ts";
import { fileManagement } from "../files/file-management-source.ts";
import { takeReadAhead } from "../files/read-ahead.ts";
import { provideUnsaved } from "./editor-close.ts";
import { keepDrafts } from "./keep-drafts.ts";

/*
 * The app's buffers for one daemon connection (docs/editor/workbench.md 56–58): every thread's
 * Editor shares one registry, so the memory cap counts all of them, and a buffer key's root is
 * the thread id (a thread names one checkout on one machine). This is the I/O shell around W2's
 * registry: the daemon's read and versioned write, drafts in IndexedDB, the merge worker, the
 * clock, and the edit calls each open editor reports for attribution.
 */

interface Attribution {
  calls: readonly EditCall[];
  /** The checkout's absolute root, for edit calls that report absolute paths. */
  checkout: string;
}

const registries = new WeakMap<ClientApi, BufferRegistry>();
/** Every registry made, for hot exit and for asking before the editor tab closes. */
const made = new Set<BufferRegistry>();
const attributions = new Map<string, Attribution>();
/** The device's one draft store (IndexedDB), shared by every registry. */
const drafts = deviceDrafts();

/**
 * Drafts the editor took over from old per-file tabs (spec 55) go to the draft store, unless one
 * is already kept for that file. Rejects when the store can't keep them, so the layout keeps
 * carrying them.
 */
export async function importDrafts(
  threadId: string,
  migrated: readonly { path: string; text: string; original: string; version: string }[],
): Promise<void> {
  for (const { path, ...draft } of migrated) {
    const key = { root: threadId, path };
    if (!(await drafts.get(key))) await drafts.put(key, draft);
  }
}

/** A thread's editor reports the edit calls its turns hold (and forgets them on unmount). */
export function setEditCalls(threadId: string, attribution: Attribution | undefined): void {
  if (attribution) attributions.set(threadId, attribution);
  else attributions.delete(threadId);
}

/** Who changed `key` on disk at `at`: the latest edit call on its path within the window. */
export function authorOf(key: BufferKey, at: number): Author {
  const own = attributions.get(key.root);
  if (!own) return { kind: "unknown" };
  // Every open editor's calls: another thread's edit in the same checkout names that thread.
  const calls = [...attributions.values()].flatMap((each) =>
    each.checkout === own.checkout ? each.calls : [],
  );
  return attribute({ path: key.path, at, threadId: key.root, checkout: own.checkout }, calls);
}

/** The registry for this connection, made on first use. */
export function editorRegistry(client: ClientApi): BufferRegistry {
  let registry = registries.get(client);
  if (registry) return registry;
  const source = daemonCheckout(client);
  registry = createBufferRegistry({
    files: checkoutFiles((threadId) => ({
      // Pictures and players are never text: the editor's viewer reads their bytes itself, so the
      // buffer doesn't read them a second time only to drop them.
      read: (path, signal) =>
        imageType(path)
          ? Promise.resolve({ kind: "image" })
          : mediaOf(path)
            ? Promise.resolve({ kind: "media" })
            : (takeReadAhead(client, threadId, path)?.catch(() =>
                source.read(threadId, path, signal),
              ) ?? source.read(threadId, path, signal)),
      mutate: (operation) => fileManagement(client, threadId).mutate(operation),
    })),
    drafts,
    merge: workerMerge(ensureEditorReady),
    now: () => Date.now(),
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    ready: ensureEditorReady,
    attribute: authorOf,
  });
  registries.set(client, registry);
  if (made.size === 0) {
    if (typeof window !== "undefined") keepDrafts(() => made);
    provideUnsaved({
      paths: unsavedPaths,
      save: async (threadId) => {
        const outcomes = await Promise.all(unsavedBuffers(threadId).map((buffer) => buffer.save()));
        return outcomes.every(
          (outcome) => outcome.kind === "saved" || outcome.kind === "unchanged",
        );
      },
      discard: async (threadId) => {
        await Promise.all(unsavedBuffers(threadId).map((buffer) => buffer.discard()));
      },
    });
  }
  made.add(registry);
  return registry;
}

/** Paths of a thread with unsaved edits, in every connection's registry. */
export function unsavedPaths(threadId: string): string[] {
  return [...made].flatMap((registry) =>
    registry.unsaved(threadId).map((buffer) => buffer.key.path),
  );
}

/** The unsaved buffers of a thread, to save or discard them all. */
export function unsavedBuffers(threadId: string) {
  return [...made].flatMap((registry) => registry.unsaved(threadId));
}
