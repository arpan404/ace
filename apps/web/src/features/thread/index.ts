/** One thread: transcript, composer, header actions and interactions. */
export { Composer, type Draft } from "./composer/composer.tsx";
export { useDraftScope } from "./composer/draft-scope.ts";
/** A thread New thread just started reads this title until the daemon titles it. */
export { rememberAttachments, rememberTitle, startedTitle } from "./composer/send-store.ts";
/** The composer's pieces New thread reuses: the approvals icon, the chip and tab styles. */
export { PermissionPicker } from "./composer/permission-picker.tsx";
export { usePermissionCapabilities } from "./composer/permission-hooks.ts";
export {
  chipControl as composerChip,
  stripControl as composerStrip,
  stripRow as composerStripRow,
} from "./composer/composer-styles.ts";
/** The tab attached to the composer's top edge. */
export { AttachedCard } from "./composer/attached-card.tsx";
export { preloadComposerParts } from "./composer/deferred-parts.tsx";
export { useComposerCompact } from "./composer/composer-compact.ts";
export { ThreadView, type ThreadTarget } from "./thread-view.tsx";
/** Warm the parts of the thread screen that load after first paint (tests start with them). */
export { preloadDeferred } from "./deferred.ts";
/** Fork from a thread's last finished turn, for menus outside the thread screen. */
export { ForkDialog } from "./transitions/fork-dialog.tsx";
export { useLatestForkPoint } from "./transitions/use-fork-point.ts";
