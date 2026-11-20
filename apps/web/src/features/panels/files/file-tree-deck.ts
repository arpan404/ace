import { useMemo } from "react";
import {
  deckKind,
  deckLayoutOf,
  findTab,
  useScopeWorkspace,
  useWorkspaceActions,
  useWorkspaceStore,
} from "@/lib/workspace/index.ts";
import { openEditorsMru, renameInLayout, type DeckRename } from "../deck/deck-layout.ts";
import { openInDeck } from "./open-file.ts";

/*
 * The explorer, content search and quick open's seam to the Deck (docs/editor/workbench.md):
 * what they ask of the editor area and what they tell it, in one small surface, answered by the
 * Deck's model (`openInDeck`, its MRU order, a rename applied to every group).
 */

/** How a file opens: a glance (preview) or kept; at a line and 0-based column. */
export interface DeckOpenOptions {
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

export { renamedPath, type DeckRename } from "../deck/deck-layout.ts";

type Listener = (path: string) => void;
const revealListeners = new Map<string, Set<Listener>>();

/**
 * Ask the thread's explorer to reveal `path`: its folders open and its row is selected and
 * scrolled into view, whether or not the explorer follows the open file. The Deck's tab menu
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

export interface Deck {
  open(path: string, options: DeckOpenOptions): void;
  /** Open editors, most recently used first. */
  openEditors: readonly string[];
  /** The explorer renamed an entry: open editors of it (or inside it) follow. */
  renamed(rename: DeckRename): void;
}

/** The thread's Deck as the explorer, search and quick open see it. */
export function useDeck(threadId: string): Deck {
  const store = useWorkspaceStore();
  const workspace = useScopeWorkspace(threadId);
  const actions = useWorkspaceActions(threadId);
  const layout = useMemo(() => deckLayoutOf(workspace), [workspace]);
  const openEditors = useMemo(() => openEditorsMru(layout), [layout]);
  const target = {
    scope: threadId,
    read: () => store.get(threadId),
    actions,
    preferred: () => store.preferred,
  };
  return {
    open: (path, options) =>
      openInDeck(target, path, {
        keep: !options.preview,
        side: options.side,
        line: options.line,
        column: options.column,
        length: options.length,
        focus: options.focus,
      }),
    openEditors,
    renamed: (rename) => {
      const current = store.get(threadId);
      if (!findTab(current, deckKind)) return;
      const before = deckLayoutOf(current);
      const next = renameInLayout(before, rename);
      if (next !== before) actions.update(deckKind, { data: next });
    },
  };
}
