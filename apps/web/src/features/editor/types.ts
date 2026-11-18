import type { Selection } from "@ace/editor";
import type { LineMark } from "@ace/ui-core";
import type { Ref } from "react";

/** What the editor exposes to code that needs to place a caret or read the text. */
export interface EditorHandle {
  focus(): void;
  text(): string;
  selections(): readonly Selection[];
  setSelections(selections: readonly Selection[]): void;
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
  /** Find from the Files toolbar (read-only mode): highlight this query and reveal its hit. */
  find?: { query: string; hit?: { line: number; column: number } | undefined } | undefined;
  /** The line area's region name for assistive tech. */
  label: string;
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
