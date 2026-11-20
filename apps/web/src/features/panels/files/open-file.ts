/*
 * The one way a checkout file opens: into the thread's Deck (docs/editor/workbench.md 8). The
 * rule lives in the foundation (`lib/workspace/deck-tab.ts`) so every opener reaches it; the
 * Files explorer, search and quick open use it from here.
 */
export {
  openInDeck,
  useOpenInDeck,
  type DeckTarget,
  type OpenInDeckOptions,
} from "@/lib/workspace/index.ts";
