import { useClient } from "@ace/client-react";
import { useMemo } from "react";
import {
  editorKind,
  editorLayoutOf,
  findTab,
  useScopeWorkspace,
  useWorkspaceActions,
  useWorkspaceStore,
} from "@/lib/workspace/index.ts";
import {
  openEditorsMru,
  renamedPath,
  renameInLayout,
  type EditorRename,
} from "../editor/editor-layout.ts";
import { editorRegistry } from "../editor/editor-registry.ts";
import { openInEditorPanel } from "./open-file.ts";

/*
 * The explorer, content search and quick open's seam to the editor (docs/editor/workbench.md):
 * what they ask of the editor area and what they tell it, in one small surface, answered by the
 * Editor's model (`openInEditorPanel`, its MRU order, a rename applied to every group).
 */

/** How a file opens: a glance (preview) or kept; at a line and 0-based column. */
export interface EditorOpenOptions {
  preview: boolean;
  line?: number | undefined;
  column?: number | undefined;
  /** With `column`, select this many code units there (a search match), revealed centred. */
  length?: number | undefined;
  /** Move the keyboard into the editor once it shows (a pick in quick open), not back where
   * focus was before. */
  focus?: boolean | undefined;
  /** ⌘↵ or ⌘-click: in the group to the right, splitting right when there is none. */
  side?: boolean | undefined;
}

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

export interface Editor {
  open(path: string, options: EditorOpenOptions): void;
  /** Open editors, most recently used first. */
  openEditors: readonly string[];
  /** The explorer renamed an entry: open editors of it (or inside it) follow, edits included. */
  renamed(rename: EditorRename): void;
}

/** The thread's editor as the explorer, search and quick open see it. */
export function useEditor(threadId: string): Editor {
  const store = useWorkspaceStore();
  const client = useClient();
  const workspace = useScopeWorkspace(threadId);
  const actions = useWorkspaceActions(threadId);
  const layout = useMemo(() => editorLayoutOf(workspace), [workspace]);
  const openEditors = useMemo(() => openEditorsMru(layout), [layout]);
  const target = {
    scope: threadId,
    read: () => store.get(threadId),
    actions,
    preferred: () => store.preferred,
  };
  return {
    open: (path, options) =>
      openInEditorPanel(target, path, {
        keep: !options.preview,
        side: options.side,
        line: options.line,
        column: options.column,
        length: options.length,
        focus: options.focus,
      }),
    openEditors,
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
