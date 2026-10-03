/** One thread: transcript, composer, header actions and interactions. */
export { Composer, type Draft } from "./composer/composer.tsx";
export { useDraftScope } from "./composer/draft-scope.ts";
export { ThreadView } from "./thread-view.tsx";
/** Where the reader left a thread; the fake boot seeds it so "New activity" has a place. */
export { markSeen } from "./transcript/seen.ts";
/** Fork from a thread's last finished turn, for menus outside the thread screen. */
export { ForkDialog } from "./transitions/fork-dialog.tsx";
export { useLatestForkPoint } from "./transitions/use-fork-point.ts";
/** An agent's open request, answered in place (Deck shows its agents' questions with it). */
export { InteractionCard as ThreadInteraction } from "./interactions/interaction-card.tsx";
