/** One thread: transcript, composer, header actions and interactions. */
export { Composer, type ComposerHandle, type Draft } from "./composer/composer.tsx";
export { useDraftScope } from "./composer/draft-scope.ts";
/** A thread New thread just started reads this title until the daemon titles it. */
export { rememberAttachments, rememberTitle, startedTitle } from "./composer/send-store.ts";
/** The composer's pieces New thread reuses: the approvals icon, the chip and tab styles. */
export { PermissionPicker } from "./composer/permission-picker.tsx";
export { useAccessModes } from "./composer/permission-hooks.ts";
export {
  chipControl as composerChip,
  composerSurface,
  stripControl as composerStrip,
  noticeSurface as composerNoticeSurface,
  environmentSurface as composerEnvironmentSurface,
  environmentRow as composerEnvironmentRow,
} from "./composer/composer-styles.ts";
/** The tab attached to the composer's top edge. */
export { preloadComposerParts } from "./composer/deferred-parts.tsx";
export { useComposerCompact } from "./composer/composer-compact.ts";
export { ThreadView, type ThreadTarget } from "./thread-view.tsx";
export { preloadPendingThread } from "./pending-thread-deferred.ts";
/** The reading column the transcript and its composer share; New thread lays its composer on it. */
export { readingColumn } from "./lib/column.ts";
/** A provider's own subagent as the whole chat, at `/t/<thread>/agents/<agent>`. */
export { SubagentView } from "./subagent/subagent-view.tsx";
/** Warm the parts of the thread screen that load after first paint (tests start with them). */
export { preloadDeferred } from "./deferred.ts";
/** Fork from a thread's last finished turn, for menus outside the thread screen. */
export { useOpenFork } from "./transitions/fork-opener.ts";
export { ForkDraftView } from "./transitions/fork-draft.tsx";
/** Forks opened and not yet sent, listed with New thread's drafts. */
export {
  forkDraftKey,
  removeForkDraft,
  saveForkDraft,
  useForkDrafts,
  type ForkDraft,
} from "./transitions/fork-drafts.ts";
export { useLatestForkPoint } from "./transitions/use-fork-point.ts";

export { PrLinksDialog } from "./pr-links-dialog-lazy.tsx";

export {
  discardSubmittedDraft,
  sameSubmittedDraft,
  type SubmittedDraft,
} from "./composer/submitted-draft.ts";
export { useWorktreeCreation } from "./worktree/use-worktree-creation.ts";
export { WorktreeCreationCard } from "./worktree/creation-card.tsx";
export { ClearStaleLock } from "./items/clear-stale-lock.tsx";
/** Drop a message that wasn't sent, with Undo; the sidebar's Unsent rows offer it too. */
export { useDiscardSend } from "./items/use-discard-send.ts";
/** The existing composer content owner, reused by visible unsent preparations. */
export {
  ComposerDraftSchema,
  discardDraft,
  readDraft,
  writeDraft,
} from "./composer/draft-store.ts";
