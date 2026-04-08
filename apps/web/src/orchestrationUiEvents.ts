import type { OrchestrationEvent } from "@ace/contracts";

export type OrchestrationUiEventFlushPriority = "animation-frame" | "microtask";

export function resolveOrchestrationUiEventFlushPriority(
  event: OrchestrationEvent,
): OrchestrationUiEventFlushPriority {
  switch (event.type) {
    case "thread.message-sent":
      // Paint-align streaming text so React only renders as fast as the browser can
      // display it, while still letting the final completion land immediately.
      return event.payload.streaming ? "animation-frame" : "microtask";
    case "thread.activity-appended":
      return "animation-frame";
    default:
      return "animation-frame";
  }
}

export function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}
