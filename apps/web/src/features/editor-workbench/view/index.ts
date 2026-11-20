/*
 * The Deck: a thread's editor workbench view (docs/editor/workbench.md, W3). Layout rules come
 * from W1's model (`@ace/ui-core/editor-workbench`); buffer facts from W2's registry, through
 * `useRegistryBuffers` (or any `DeckBuffers`).
 */

export { Deck, type DeckProps } from "./deck.tsx";
export { OpenEditors } from "./open-editors.tsx";
export type { DeckLayoutProps } from "./group-actions.ts";
export type { BufferChanger, BufferFacts, BufferLoad, DeckBuffers } from "./buffers.ts";
export type { DeckEditorProps, StatusNotice, StatusReport } from "./deck-host.ts";
export {
  factsOf,
  registryBuffers,
  useRegistryBuffers,
  type RegistryBuffers,
} from "./registry-buffers.ts";
