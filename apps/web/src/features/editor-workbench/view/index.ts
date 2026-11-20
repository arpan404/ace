/*
 * The Deck: a thread's editor workbench view (docs/editor/workbench.md, W3). Layout rules come
 * from W1's model (`@ace/ui-core/editor-workbench`); buffers from W2's registry
 * (`editor-workbench/buffers`), held per open path by `useDeckBuffers`.
 */

export { Deck, type DeckProps } from "./deck.tsx";
export { OpenEditors } from "./open-editors.tsx";
export type { DeckLayoutProps } from "./group-actions.ts";
export {
  deckBuffers,
  useDeckBuffers,
  useSnapshot,
  type Changer,
  type DeckBuffers,
} from "./deck-buffers.ts";
export { DeckEditor } from "./deck-editor.tsx";
export { compactBelowPx } from "./deck.tsx";
export type {
  DeckEditorProps,
  DeckViewerProps,
  EditorReveal,
  StatusNotice,
  StatusReport,
} from "./deck-host.ts";
