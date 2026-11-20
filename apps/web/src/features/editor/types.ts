import type { Selection } from "@ace/editor";
import type { LineMark } from "@ace/ui-core";
import type { Ref } from "react";
import type { EditorStatus, EditorStatusActions } from "./editor-status.ts";

/** What the editor exposes to code that needs to place a caret or read the text. */
export interface EditorHandle {
  focus(): void;
  text(): string;
  /** The document's edit count, for a caller that tracks dirtiness without the text. */
  version(): number;
  selections(): readonly Selection[];
  setSelections(selections: readonly Selection[]): void;
  /** What a status line shows for this editor now; undefined until the document has loaded. */
  status(): EditorStatus | undefined;
  /** The setters behind the status line's menus, for a status line drawn outside the editor. */
  statusActions(): EditorStatusActions;
}

export interface CodeEditorProps {
  /** The text when the editor opens; later edits live in the document, not this prop. */
  text: string;
  /** The file's path: its language, its comment token and the name the textarea announces. */
  path: string;
  readOnly?: boolean;
  /** Gutter marks from the checkout's diff; unset, the editor diffs against its own opening. */
  marks?: ReadonlyMap<number, LineMark> | undefined;
  /** A 1-based line to bring into view once. */
  line?: number | undefined;
  /** With `line`, the 0-based UTF-16 column on it to bring into view (a search match's). */
  column?: number | undefined;
  /** Find from the Files toolbar (read-only mode): highlight this query and reveal its hit. */
  find?: { query: string; hit?: { line: number; column: number } | undefined } | undefined;
  /** The line area's region name for assistive tech. */
  label: string;
  /** Wrap long lines at the editor's width, as the Files tab's preference asks. */
  wrap?: boolean;
  /**
   * The status line under the text (position, indentation, line ending, language). On by
   * default; a workbench that draws one status line for its focused editor turns it off.
   */
  statusLine?: boolean;
  /** Hears the editor's status each time it would read differently. */
  onStatus?: ((status: EditorStatus) => void) | undefined;
  /** Draw a mark for every space and tab. Off by default; the status line can turn it on. */
  renderWhitespace?: boolean;
  /** Vertical rulers at these columns. None by default. */
  rulers?: readonly number[];
  /** Alt+Z: the person asked for wrap to toggle. */
  onToggleWrap?: (() => void) | undefined;
  /** Called after each edit; read the text through the handle when it is actually needed. */
  onEdit?: (() => void) | undefined;
  onBlur?: (() => void) | undefined;
  /** The text once, as the editor unmounts, for a caller that keeps a draft. */
  onTextDispose?: ((text: string) => void) | undefined;
  onSave?: (() => void) | undefined;
  /** Whether lines run past the editor's right edge, for the toolbar's fade. */
  onHorizontalOverflow?: ((overflow: boolean) => void) | undefined;
  /** Idle time that ends a typing run, as one undo step. */
  commitAfter?: number;
  /** How long typing settles before colours are rebuilt; tests stretch it. */
  highlightDelay?: number;
  focusOnMount?: boolean;
  className?: string;
  ref?: Ref<EditorHandle>;
}
