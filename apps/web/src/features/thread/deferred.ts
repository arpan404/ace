import { threadWorkspace } from "@/features/panels/index.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { preloadComposerCards } from "./composer/deferred-cards.ts";
import { preloadComposerParts } from "./composer/deferred-parts.tsx";
import { DeferredInteractionCard, DeferredQuestionRecord } from "./interactions/deferred-card.ts";
import { DeferredReviewNote, DeferredReviewSummary } from "./items/deferred-review.ts";
import { preloadJump } from "./long/jump.ts";

export { DeferredInteractionCard };

/*
 * Parts of the thread screen that only appear on demand: a step's detail (output, diff,
 * reasoning) when it is expanded, the card for a pending approval, question or plan, and the
 * header's menus. They
 * load after the transcript has painted, while the browser is idle, so they are ready before
 * they are needed without weighing on the route's first paint (ADR 0056 route budget).
 */
export const DeferredStepDetail = deferredComponent(() =>
  import("./items/step-detail.tsx").then((module) => module.StepDetail),
);

/** The header's ⋯ menu items (the shared thread actions) and the summary's contents. */
export const DeferredThreadMenu = deferredComponent(() =>
  import("./header/thread-menu.tsx").then((module) => module.ThreadMenuItems),
);
/** The open thread's rename, pin and archive shortcuts, from the same chunk as its ⋯ menu. */
export const DeferredThreadHotkeys = deferredComponent(() =>
  import("./header/thread-menu.tsx").then((module) => module.ThreadHotkeys),
);
export const DeferredSummaryBody = deferredComponent(() =>
  import("./header/summary-body.tsx").then((module) => module.SummaryBody),
);
/** "Limited until 15:20" beside the project in the header, while the thread is held at a limit. */
export const DeferredLimitBadge = deferredComponent(() =>
  import("./header/limit-badge.tsx").then((module) => module.LimitBadge),
);
/** The pinned summary's ⋯: the project's and git's actions. */
export const DeferredSummaryMenu = deferredComponent(() =>
  import("./header/summary-menu.tsx").then((module) => module.SummaryMenu),
);

/**
 * The long-thread tools, loaded when first opened and warmed while idle: the turn timeline,
 * search within the thread and the catch-up card (ADR 0056: off the route's first paint).
 */
export const DeferredTurnsPanel = deferredComponent(() =>
  import("./long/timeline.tsx").then((module) => module.TurnsPanel),
);
export const DeferredSearchBar = deferredComponent(() =>
  import("./long/search-bar.tsx").then((module) => module.SearchBar),
);

/** What only a jump shows: where the reader is, and the gap to the live end. */
export const DeferredJumpBar = deferredComponent(() =>
  import("./long/jump-chrome.tsx").then((module) => module.JumpBar),
);
export const DeferredJumpFailed = deferredComponent(() =>
  import("./long/jump-chrome.tsx").then((module) => module.JumpFailed),
);
export const DeferredGapRow = deferredComponent(() =>
  import("./long/jump-chrome.tsx").then((module) => module.GapRow),
);
/** Back to the live end, shown once the reader has left it. */
export const DeferredLivePill = deferredComponent(() =>
  import("./long/live-pill.tsx").then((module) => module.LivePill),
);
/** Older turns folded to a digest line, and the header that folds an opened one again. */
export const DeferredFoldedTurn = deferredComponent(() =>
  import("./long/turn-row.tsx").then((module) => module.FoldedTurn),
);
export const DeferredOpenTurnHead = deferredComponent(() =>
  import("./long/turn-row.tsx").then((module) => module.OpenTurnHead),
);
/** ⌥⌘↑ and ⌥⌘↓ between turns, bound once the thread screen is idle. */
export const DeferredTurnKeys = deferredComponent(() =>
  import("./long/turn-keys.tsx").then((module) => module.TurnKeys),
);
/** The catch-up check, its card and the read cursor that advances while the reader follows. */
export const DeferredCatchUpSlot = deferredComponent(() =>
  import("./long/catch-up-slot.tsx").then((module) => module.CatchUpSlot),
);

/** The Agents panel's follow-up composer; loads while idle, after the thread paints. */
export const DeferredAgentComposer = deferredComponent(() =>
  import("./composer/agent-composer.tsx").then((module) => module.AgentComposer),
);

export function preloadDeferred(): Promise<unknown> {
  return Promise.all([
    DeferredAgentComposer.preload(),
    DeferredStepDetail.preload(),
    DeferredInteractionCard.preload(),
    DeferredQuestionRecord.preload(),
    DeferredReviewNote.preload(),
    DeferredReviewSummary.preload(),
    DeferredThreadMenu.preload(),
    DeferredSummaryBody.preload(),
    DeferredSummaryMenu.preload(),
    // The workspace's tab kinds (icons, badges, loaders), so a tool opens without waiting.
    threadWorkspace.load(),
    preloadComposerParts(),
    preloadComposerCards(),
    DeferredTurnsPanel.preload(),
    DeferredSearchBar.preload(),
    DeferredJumpBar.preload(),
    DeferredGapRow.preload(),
    DeferredJumpFailed.preload(),
    DeferredLivePill.preload(),
    DeferredFoldedTurn.preload(),
    DeferredOpenTurnHead.preload(),
    DeferredCatchUpSlot.preload(),
    DeferredTurnKeys.preload(),
    preloadJump(),
    // Thumbnails and file chips: their shell, then their tiles.
    import("@/components/attachment-message.tsx").then((module) => module.preloadAttachments()),
  ]);
}
