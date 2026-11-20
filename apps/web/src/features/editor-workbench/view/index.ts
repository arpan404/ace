/*
 * The Deck: a thread's editor workbench view (docs/editor/workbench.md, W3). The layout rules
 * come from W1's model and the buffer facts from W2's registry, through the interfaces here.
 */

export { Deck, type DeckProps } from "./deck.tsx";
export { OpenEditors } from "./open-editors.tsx";
export type { BufferChanger, BufferFacts, BufferLoad, DeckBuffers } from "./buffers.ts";
export type { DeckEditorProps, EditorStatus, StatusItem, StatusNotice } from "./deck-host.ts";
export type { DeckGroup, DeckLayout, DeckNode, DeckOps, DeckSplit, DeckTab } from "./layout.ts";
export { createInterimOps } from "./interim-ops.ts";
