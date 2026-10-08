/**
 * Deck (@ace/conductor): multi-agent runs, their plan, lanes and open decisions.
 * Deck is called Offshift in the UI: each run is "an offshift", the view is "Offshifts".
 */
export { DeckLandingScreen, NewDeckScreen } from "./deck-landing-screen.tsx";
export { DeckRunPage } from "./deck-run-page.tsx";
export { DeckSidebar } from "./deck-sidebar.tsx";
export { useDeckDecisions, type DeckDecision, type DeckOwner } from "./deck-decisions.ts";
export { useDeckSender } from "./use-deck-store.ts";
/** A lane as a workspace tab beside a thread, and a thread's deck in its Agents tab (lazy). */
export { deckLaneParts } from "./deck-lane-parts.ts";
