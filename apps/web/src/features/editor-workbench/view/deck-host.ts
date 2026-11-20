import type { ReactNode } from "react";
import type { DeckBuffers } from "./buffers.ts";

/**
 * The status line's facts about one editor (spec 41). The editor-commands branch fills them
 * from the editor handle; the Deck shows only the focused group's.
 */
export interface EditorStatus {
  /** Left: what needs a look about this editor ("Couldn't save store.ts. The disk is full."). */
  notice?: StatusNotice | undefined;
  /** Right: "Ln 25, Col 35", indentation, encoding, line ending, language. Each may open a menu. */
  items: readonly StatusItem[];
}

export interface StatusNotice {
  text: string;
  action?: { label: string; run(): void } | undefined;
}

export interface StatusItem {
  id: string;
  label: string;
  run?: (() => void) | undefined;
}

/** What the Deck hands the editor it renders for a group's active tab. */
export interface DeckEditorProps {
  path: string;
  group: string;
  focused: boolean;
  /** The editor's current status; `undefined` when it unmounts or has none. */
  onStatus(status: EditorStatus | undefined): void;
}

/** Everything a group needs from outside the layout. */
export interface DeckHost {
  buffers: DeckBuffers;
  renderEditor(props: DeckEditorProps): ReactNode;
  reportStatus(group: string, status: EditorStatus | undefined): void;
  onMerge(path: string): void;
  onCompare(path: string): void;
  onQuickOpen?: (() => void) | undefined;
  onRestore?: ((path: string) => void) | undefined;
  onOpenReadOnly?: ((path: string) => void) | undefined;
  onRetry?: ((path: string) => void) | undefined;
}
