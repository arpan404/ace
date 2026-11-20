import type { ReactNode } from "react";
import type { EditorStatus, EditorStatusActions } from "@/features/editor";
import type { TextBuffer } from "../buffers/index.ts";
import type { DeckBuffers } from "./deck-buffers.ts";

/** A left-hand status line notice: what needs a look ("Claude Code changed 2 open files"). */
export interface StatusNotice {
  text: string;
  action?: { label: string; run(): void } | undefined;
}

/** One editor's status line data, as editor-commands reports it. */
export interface StatusReport {
  status: EditorStatus;
  actions: EditorStatusActions;
}

/** What the Deck hands the editor it renders for a group's active tab. */
export interface DeckEditorProps {
  path: string;
  group: string;
  focused: boolean;
  /** The path's shared buffer (W2): its `view()` is the document `CodeEditor` shows. */
  buffer: TextBuffer;
  /**
   * The editor's status and setters, for the Deck's one status line (it keeps each group's
   * latest and shows the focused group's). Called with `undefined` on unmount.
   */
  onStatus(status: EditorStatus | undefined, actions?: EditorStatusActions): void;
}

/** Everything a group needs from outside the layout. */
export interface DeckHost {
  buffers: DeckBuffers;
  /** Draw a group's editor; unset, the Deck draws `CodeEditor` on the shared buffer. */
  renderEditor?: ((props: DeckEditorProps) => ReactNode) | undefined;
  reportStatus(group: string, report: StatusReport | undefined): void;
  /** Unset, Merge runs the buffer's own three-way merge. */
  onMerge?: ((path: string) => void) | undefined;
  /** Compare opens a diff of disk against the buffer in a new tab (W5). */
  onCompare(path: string): void;
  onQuickOpen?: (() => void) | undefined;
}
