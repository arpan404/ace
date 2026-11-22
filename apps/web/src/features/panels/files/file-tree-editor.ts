import { useClient } from "@ace/client-react";
import {
  editorKind,
  editorLayoutOf,
  findTab,
  useWorkspaceActions,
  useWorkspaceStore,
} from "@/lib/workspace/index.ts";
import { renamedPath, renameInLayout, type EditorRename } from "../editor/editor-layout.ts";
import { editorRegistry } from "../editor/editor-registry.ts";
import { useEditorOpen, type EditorOpen } from "./editor-open.ts";

/*
 * The explorer, content search and quick open's seam to the editor (docs/editor/workbench.md):
 * what they ask of the editor area and what they tell it, in one small surface, answered by the
 * Editor's model (`openInEditorPanel`, its MRU order, a rename applied to every group). Opening
 * and the MRU order alone are `editor-open.ts`, which quick open uses without the buffers.
 */

export type { EditorOpenOptions } from "./editor-open.ts";

export { renamedPath, type EditorRename } from "../editor/editor-layout.ts";

type Listener = (path: string) => void;
const revealListeners = new Map<string, Set<Listener>>();

/**
 * Ask the thread's explorer to reveal `path`: its folders open and its row is selected and
 * scrolled into view, whether or not the explorer follows the open file. The editor's tab menu
 * (Reveal in Files) calls this.
 */
export function revealInExplorer(threadId: string, path: string): void {
  for (const listener of revealListeners.get(threadId) ?? []) listener(path);
}

/** Hear `revealInExplorer` for a thread. Returns the unsubscribe. */
export function onRevealInExplorer(threadId: string, listener: Listener): () => void {
  let listeners = revealListeners.get(threadId);
  if (!listeners) {
    listeners = new Set();
    revealListeners.set(threadId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) revealListeners.delete(threadId);
  };
}

export interface Editor extends EditorOpen {
  /** The explorer renamed an entry: open editors of it (or inside it) follow, edits included. */
  renamed(rename: EditorRename): void;
}

/** The thread's editor as the explorer, search and quick open see it. */
export function useEditor(threadId: string): Editor {
  const store = useWorkspaceStore();
  const client = useClient();
  const actions = useWorkspaceActions(threadId);
  return {
    ...useEditorOpen(threadId),
    renamed: (rename) => {
      // Unsaved buffers and their drafts move first, so the tabs find them at the new paths.
      editorRegistry(client).rename(threadId, (path) => renamedPath(path, rename));
      const current = store.get(threadId);
      if (!findTab(current, editorKind)) return;
      const before = editorLayoutOf(current);
      const next = renameInLayout(before, rename);
      if (next !== before) actions.update(editorKind, { data: next });
    },
  };
}
