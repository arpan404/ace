import type { ReactNode } from "react";
import type { EditorStatus, EditorStatusActions } from "@/features/editor";
import type { DeckBuffers } from "./buffers.ts";

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
  /**
   * Pass to `CodeEditor` (with `statusLine={false}`): `onStatus={(status) =>
   * props.onStatus(status, handle.statusActions())}`. Call with `undefined` on unmount. The
   * Deck keeps each group's latest and draws one status line, for the focused group.
   */
  onStatus(status: EditorStatus | undefined, actions?: EditorStatusActions): void;
}

/** Everything a group needs from outside the layout. */
export interface DeckHost {
  buffers: DeckBuffers;
  renderEditor(props: DeckEditorProps): ReactNode;
  reportStatus(group: string, report: StatusReport | undefined): void;
  onMerge(path: string): void;
  onCompare(path: string): void;
  onQuickOpen?: (() => void) | undefined;
  onRestore?: ((path: string) => void) | undefined;
  onOpenReadOnly?: ((path: string) => void) | undefined;
  onRetry?: ((path: string) => void) | undefined;
}
