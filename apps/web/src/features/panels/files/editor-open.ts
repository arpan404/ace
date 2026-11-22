import { useMemo } from "react";
import {
  editorLayoutOf,
  useScopeWorkspace,
  useWorkspaceActions,
  useWorkspaceStore,
} from "@/lib/workspace/index.ts";
import { openEditorsMru } from "../editor/editor-layout.ts";
import { openInEditorPanel } from "./open-file.ts";

/*
 * The light half of the explorer's seam to the editor: opening a file there and reading its
 * open editors, answered by the workspace's layout alone. Quick open uses only this, so its
 * code (fetched the first time ⌘P is pressed) never pulls in the code editor, its Wasm or the
 * workbench view; `.dependency-cruiser.cjs` holds it to that.
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

export interface EditorOpen {
  open(path: string, options: EditorOpenOptions): void;
  /** Open editors, most recently used first. */
  openEditors: readonly string[];
}

/** Open files in the thread's editor, and its open editors, most recently used first. */
export function useEditorOpen(threadId: string): EditorOpen {
  const store = useWorkspaceStore();
  const workspace = useScopeWorkspace(threadId);
  const actions = useWorkspaceActions(threadId);
  const openEditors = useMemo(() => openEditorsMru(editorLayoutOf(workspace)), [workspace]);
  return {
    open: (path, options) =>
      openInEditorPanel(
        {
          scope: threadId,
          read: () => store.get(threadId),
          actions,
          preferred: () => store.preferred,
        },
        path,
        {
          keep: !options.preview,
          side: options.side,
          line: options.line,
          column: options.column,
          length: options.length,
          focus: options.focus,
        },
      ),
    openEditors,
  };
}
