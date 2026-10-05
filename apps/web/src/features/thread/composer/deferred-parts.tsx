import { deferredComponent } from "@/lib/deferred-component.tsx";
import { preloadAttachmentChips } from "./attachments.tsx";
import { preloadComposerMenus } from "./deferred-menus.tsx";

/*
 * Composer parts that aren't the bare input and footer: the thread's footer controls, the queue
 * above it and the suggestion list, plus the menus. Their code loads after the thread has
 * painted, warmed while idle with the rest of `preloadDeferred`, which keeps the thread route
 * inside its ADR 0056 budget.
 */
export const DeferredThreadControls = deferredComponent(() =>
  import("./thread-controls.tsx").then((module) => module.ThreadControls),
);
export const DeferredQueueArea = deferredComponent(() =>
  import("./queue-area.tsx").then((module) => module.QueueArea),
);
export const DeferredSuggestionList = deferredComponent(() =>
  import("./suggestion-list.tsx").then((module) => module.SuggestionList),
);

/** How a message on its way is doing, under its bubble: Sending…, Not sent with Retry and Edit. */
export const DeferredSendStatus = deferredComponent(() =>
  import("../items/send-status.tsx").then((module) => module.SendStatus),
);
/** This window's messages on their way, for the transcript (see `local-sends-view.ts`). */
export const DeferredLocalSends = deferredComponent(() =>
  import("../items/local-sends.tsx").then((module) => module.LocalSends),
);
/** A follow-up to one agent of the tree, in the Agents panel. */
export const DeferredAgentComposer = deferredComponent(() =>
  import("./agent-composer.tsx").then((module) => module.AgentComposer),
);
/** Says so when the daemon refuses a follow-up sent to one agent of the tree. */
export const DeferredAgentSendWatch = deferredComponent(() =>
  import("./agent-send-watch.tsx").then((module) => module.AgentSendWatch),
);

/** The thread's tokens and cost in the context meter's tooltip, read when the tooltip opens. */
export const DeferredThreadUsage = deferredComponent(() =>
  import("./thread-usage.tsx").then((module) => module.ThreadUsage),
);

export function preloadComposerParts(): Promise<unknown> {
  return Promise.all([
    preloadComposerMenus(),
    // The model chip's popover, through the controls' own chunk so the route never holds it.
    import("@/features/models/index.ts").then((models) => models.preloadModelControl()),
    DeferredThreadControls.preload(),
    DeferredQueueArea.preload(),
    DeferredSuggestionList.preload(),
    DeferredThreadUsage.preload(),
    DeferredSendStatus.preload(),
    DeferredLocalSends.preload(),
    preloadAttachmentChips(),
    import("./send-message.ts"),
    DeferredAgentComposer.preload(),
  ]);
}

/** Room for the thread's footer controls while their code arrives: same height, nothing drawn. */
export function ControlsPending() {
  return <span aria-hidden className="h-(--composer-control) w-40 shrink" />;
}
