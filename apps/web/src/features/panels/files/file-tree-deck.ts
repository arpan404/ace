import { useMemo } from "react";
import {
  findTab,
  useScopeWorkspace,
  useWorkspaceActions,
  type ScopeWorkspace,
  type WorkspaceActions,
} from "@/lib/workspace/index.ts";
import { fileTabData, useRecentFiles } from "./files-state.ts";
import { openFile } from "./open-file.ts";
import { fileTabId } from "./tab-id.ts";

/*
 * The explorer, content search and quick open's seam to the Deck (docs/editor/workbench.md):
 * what they ask of the editor area and what they tell it, in one small surface. The cut-over
 * (W5) swaps the bodies marked "today" for the Deck's model (`openEditor`, `mruTabs`, a rename
 * applied to every group); the callers stay as they are. Until then the per-file panel tabs
 * answer.
 */

/** How a file opens: a glance (preview) or kept; at a line and 0-based column. */
export interface DeckOpenOptions {
  preview: boolean;
  line?: number | undefined;
  column?: number | undefined;
  /** Move the keyboard into the editor once it shows (a pick in quick open), not back where
   * focus was before. */
  focus?: boolean | undefined;
}

/** A checkout entry renamed (or moved) in this window: `from` and `to` are checkout paths. */
export interface DeckRename {
  from: string;
  to: string;
  /** A folder: every open path inside it follows. */
  folder: boolean;
}

/** Where `path` is after `rename`, or undefined when the rename doesn't touch it. */
export function renamedPath(path: string, rename: DeckRename): string | undefined {
  if (path === rename.from) return rename.to;
  if (rename.folder && path.startsWith(`${rename.from}/`))
    return `${rename.to}${path.slice(rename.from.length)}`;
  return undefined;
}

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

/**
 * Open editors, most recently used first. Today: the showing file tab, then the other file tabs
 * in the order their files were last shown.
 */
export function openEditorsMru(
  workspace: ScopeWorkspace,
  recent: readonly string[],
): readonly string[] {
  const open: string[] = [];
  for (const tab of workspace.tabs) {
    if (tab.kind !== "files") continue;
    const path = fileTabData(tab).path;
    if (path && !open.includes(path)) open.push(path);
  }
  const active = workspace.active ? findTab(workspace, workspace.active)?.tab : undefined;
  const shown = active?.kind === "files" ? fileTabData(active).path : undefined;
  const rank = (path: string) => {
    if (path === shown) return -1;
    const at = recent.indexOf(path);
    return at < 0 ? recent.length : at;
  };
  return open.toSorted((a, b) => rank(a) - rank(b));
}

/** Today: every file tab showing a renamed path shows its new path, keeping its state. */
function followInPanelTabs(
  workspace: ScopeWorkspace,
  actions: WorkspaceActions,
  rename: DeckRename,
): void {
  for (const tab of workspace.tabs) {
    if (tab.kind !== "files") continue;
    const data = fileTabData(tab);
    const next = data.path === undefined ? undefined : renamedPath(data.path, rename);
    if (next === undefined) continue;
    actions.replace(tab.key, { kind: "files", id: fileTabId(next), data: { ...data, path: next } });
  }
}

const focusFrames = 60;

/**
 * Once `path`'s editor is on screen and no dialog holds the keyboard, focus the editor. A key or
 * a click meanwhile leaves focus where the person put it. Today the editor is the file tab's
 * "Source of …" region; the Deck focuses its own editor instead.
 */
function focusEditorSoon(doc: Document, path: string): void {
  let left = focusFrames;
  let frame = 0;
  let settled = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    doc.removeEventListener("pointerdown", stop, true);
    doc.removeEventListener("keydown", stop, true);
  };
  const look = () => {
    left -= 1;
    const dialog = doc.querySelector('[role="dialog"], [data-part="command-palette"]');
    const field = dialog
      ? null
      : doc
          .querySelector(`[role="region"][aria-label="${CSS.escape(`Source of ${path}`)}"]`)
          ?.querySelector<HTMLElement>("textarea");
    if (field && doc.activeElement !== field) {
      field.focus({ preventScroll: true });
      settled = 0;
    } else if (field) settled += 1;
    // A closing dialog hands focus back on its way out: hold the editor a few frames past it.
    if (left <= 0 || settled >= 3) return stop();
    frame = requestAnimationFrame(look);
  };
  doc.addEventListener("pointerdown", stop, true);
  doc.addEventListener("keydown", stop, true);
  frame = requestAnimationFrame(look);
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
  const workspace = useScopeWorkspace(threadId);
  const actions = useWorkspaceActions(threadId);
  const recent = useRecentFiles(threadId);
  const openEditors = useMemo(() => openEditorsMru(workspace, recent), [workspace, recent]);
  return {
    open: (path, options) => {
      openFile(workspace, actions, path, {
        keep: !options.preview,
        line: options.line,
        column: options.column,
      });
      if (options.focus) focusEditorSoon(document, path);
    },
    openEditors,
    renamed: (rename) => followInPanelTabs(workspace, actions, rename),
  };
}
