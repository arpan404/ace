import type { Applied, EditorDocument, LineEdit, Selection, TextReplacement } from "@ace/editor";
import type { LineMark } from "@ace/ui-core";
import type { Ref } from "react";
import type { EditorStatus, EditorStatusActions } from "./editor-status.ts";
import type { EditorLayer } from "./layer.ts";

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

/** One applied edit's changed lines, with the document's line count and version after it. */
export interface EditBatch {
  spans: readonly LineEdit[];
  /** The ranges the transaction replaced, for carrying a stored position through it. */
  replacements: readonly TextReplacement[];
  lines: number;
  /** The document's version once the spans were applied. */
  version: number;
}

/** One mounted view of a shared document, as its owner and the document's other views reach it. */
export interface DocumentView {
  /** Runs `run` on the document the way this view's own edits run (the owner's reload or merge). */
  edit(run: (doc: EditorDocument) => Applied | undefined): boolean;
  /** Another view is about to change the document: read your rows while they still match it. */
  before(): void;
  /** Another view changed the document by `batch`: redraw as for an edit of your own. */
  applied(batch: EditBatch): void;
}

/**
 * A document its caller owns and shares between views (the editor's buffer registry). Each mounted
 * view joins through `attach`: text the owner lands (a reload, a merge) runs through a view's edit
 * path, and every edit, whichever view or owner made it, reaches every other view, so two splits
 * of one file keep their rows, colours and carets on the same text.
 */
export interface SharedDocument {
  doc: EditorDocument;
  /** The mounted view joins; the returned function lets it go. */
  attach(view: DocumentView): () => void;
  /** The views mounted now, oldest first. */
  views(): readonly DocumentView[];
}

export interface CodeEditorProps {
  /**
   * The text when the editor opens; later edits live in the document, not this prop. With
   * `document`, only what the gutter compares against.
   */
  text: string;
  /** Show and edit this document instead of making one; the editor never frees it. */
  document?: SharedDocument | undefined;
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
  /** Drawn over the text and told of its edits: code annotations (`useEditorAnnotations`). */
  layer?: EditorLayer | undefined;
  className?: string;
  ref?: Ref<EditorHandle>;
}
