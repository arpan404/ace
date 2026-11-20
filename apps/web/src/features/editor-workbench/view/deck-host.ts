import type { LineMark } from "@ace/ui-core";
import type { ReactNode } from "react";
import type { EditorLayer, EditorStatus, EditorStatusActions } from "@/features/editor";
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

/** A place an open asked the editor to show (spec 12–13). */
export interface EditorReveal {
  /** 1-based; unset, the caret stays where it was and only focus moves. */
  line?: number | undefined;
  /** 0-based UTF-16 column. */
  column?: number | undefined;
  /** Select this many code units from the column (a search match). */
  length?: number | undefined;
  /** Move the keyboard into the editor. */
  focus: boolean;
  /** A new token reveals again, even at the same place. */
  token: number;
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
  /** Where to look once shown; `onRevealed` hears its token when the editor has done so. */
  reveal?: EditorReveal | undefined;
  onRevealed?: ((token: number) => void) | undefined;
  /**
   * The file's lines changed since the last commit (spec 44), drawn while the buffer has no
   * unsaved edits; while it has, the gutter marks the person's own lines against the saved text.
   */
  marks?: ReadonlyMap<number, LineMark> | undefined;
  /** Drawn over the text: the thread's code annotations (`useEditorAnnotations`). */
  layer?: EditorLayer | undefined;
}

/** A file the editor doesn't show as text: a picture, a player, a binary or too-large file. */
export interface DeckViewerProps {
  path: string;
  group: string;
  /** What the read found instead of text: "image", "media", "binary", "large". */
  reason: string;
}

/** A file whose disk version moved under unsaved edits, to compare. */
export interface DeckCompareProps {
  path: string;
  buffer: TextBuffer;
}

/** Everything a group needs from outside the layout. */
export interface DeckHost {
  buffers: DeckBuffers;
  /** Draw a group's editor; unset, the Deck draws `CodeEditor` on the shared buffer. */
  renderEditor?: ((props: DeckEditorProps) => ReactNode) | undefined;
  /**
   * Draw a file the editor doesn't take, read only (spec 65); unset, the group says why in one
   * line.
   */
  renderViewer?: ((props: DeckViewerProps) => ReactNode) | undefined;
  reportStatus(group: string, report: StatusReport | undefined): void;
  /** Unset, Merge runs the buffer's own three-way merge. */
  onMerge?: ((path: string) => void) | undefined;
  /**
   * Compare's diff of the disk's text against the unsaved buffer (spec 46), shown in the group
   * in place of the editor while the change waits for an answer. Unset, the notice has no
   * Compare.
   */
  renderCompare?: ((props: DeckCompareProps) => ReactNode) | undefined;
  onQuickOpen?: (() => void) | undefined;
  /** The host's own items at the end of a tab's menu: Reveal in Files, Open in ›, the paths. */
  tabMenuItems?: ((path: string) => ReactNode) | undefined;
}
