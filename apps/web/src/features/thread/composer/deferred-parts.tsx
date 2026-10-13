import { deferredComponent } from "@/lib/deferred-component.tsx";
import { preloadAttachmentChips } from "./attachments.tsx";
import { preloadComposerMenus } from "./deferred-menus.tsx";

/*
 * Composer parts that aren't the bare input and footer: the thread's footer controls and the
 * suggestion list, plus the menus (the strip above it is in `deferred-cards.ts`). Their code loads after the thread has
 * painted, warmed while idle with the rest of `preloadDeferred`, which keeps the thread route
 * inside its ADR 0056 budget.
 */
export const DeferredPermissionControl = deferredComponent(() =>
  import("./thread-controls.tsx").then((module) => module.ThreadPermissionControl),
);
export const DeferredModelControl = deferredComponent(() =>
  import("./thread-controls.tsx").then((module) => module.ThreadModelControl),
);
export const DeferredSuggestionList = deferredComponent(() =>
  import("./suggestion-list.tsx").then((module) => module.SuggestionList),
);

/** How a message on its way is doing, under its bubble: Sending…, Not sent with Retry and Edit. */
export const DeferredSendStatus = deferredComponent(() =>
  import("../items/send-status.tsx").then((module) => module.SendStatus),
);
/** This window's messages on their way, for the transcript (see `LocalSendsView`). */
export const DeferredLocalSends = deferredComponent(() =>
  import("../items/local-sends.tsx").then((module) => module.LocalSends),
);

export function preloadComposerParts(): Promise<unknown> {
  return Promise.all([
    preloadComposerMenus(),
    // The model chip's popover, through the controls' own chunk so the route never holds it.
    import("@/features/models/index.ts").then((models) => models.preloadModelControl()),
    DeferredPermissionControl.preload(),
    DeferredModelControl.preload(),
    DeferredSuggestionList.preload(),
    DeferredSendStatus.preload(),
    DeferredLocalSends.preload(),
    preloadAttachmentChips(),
    import("./send-message.ts"),
  ]);
}

/** Room for the thread's footer controls while their code arrives: same height, nothing drawn. */
export function ControlsPending() {
  return <span aria-hidden className="h-(--composer-control) w-24 shrink" />;
}

export const DeferredCursorContinuation = deferredComponent(() =>
  import("./cursor-continuation.tsx").then((module) => module.CursorContinuation),
);

export const DeferredCommandArguments = deferredComponent(() =>
  import("./command-arguments.tsx").then((module) => module.CommandArguments),
);

export const DeferredThreadAttachments = deferredComponent(() =>
  import("./thread-attachments.tsx").then((module) => module.ThreadAttachments),
);
