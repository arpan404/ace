/** One thread: transcript, composer, header actions and interactions. */
export { Composer, type Draft } from "./composer/composer.tsx";
export { useDraftScope } from "./composer/draft-scope.ts";
/** A thread New thread just started reads this title until the daemon titles it. */
export { rememberTitle } from "./composer/send-store.ts";
/** The composer's footer pieces New thread reuses: the approvals chip and the chip style. */
export { PermissionPicker } from "./composer/permission-picker.tsx";
export { usePermissionCapabilities } from "./composer/permission-hooks.ts";
export { chipControl as composerChip } from "./composer/composer-styles.ts";
export { preloadComposerParts } from "./composer/deferred-parts.tsx";
export { useComposerCompact } from "./composer/composer-compact.ts";
export { ThreadView, type ThreadTarget } from "./thread-view.tsx";
/** Warm the parts of the thread screen that load after first paint (tests start with them). */
export { preloadDeferred } from "./deferred.ts";
/** Fork from a thread's last finished turn, for menus outside the thread screen. */
export { ForkDialog } from "./transitions/fork-dialog.tsx";
export { useLatestForkPoint } from "./transitions/use-fork-point.ts";
/**
 * An agent's open request, answered in place (Deck shows its agents' questions with it). Its
 * code loads on first render (suspends until then), so importing it costs a caller nothing.
 */
export { DeferredThreadInteraction } from "./interactions/deferred-card.ts";
