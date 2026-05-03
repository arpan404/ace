import { describe, expect, it } from "vitest";
import type { OrchestrationEvent } from "@ace/contracts";
import { notificationFromDomainEvent, notificationThreadRouteFromData } from "./notifications";

function event(input: {
  readonly payload: Record<string, unknown>;
  readonly type: OrchestrationEvent["type"];
}): OrchestrationEvent {
  return {
    aggregateId: "thread-1",
    aggregateKind: "thread",
    causationEventId: null,
    commandId: null,
    correlationId: null,
    eventId: "event-1",
    metadata: {},
    occurredAt: "2026-05-03T00:00:00.000Z",
    payload: input.payload,
    sequence: 1,
    type: input.type,
  } as OrchestrationEvent;
}

describe("notificationThreadRouteFromData", () => {
  it("resolves thread routes from notification payload data", () => {
    expect(
      notificationThreadRouteFromData({
        hostId: "host-1",
        threadId: "thread-1",
        eventType: "thread.activity-appended",
      }),
    ).toEqual({
      hostId: "host-1",
      threadId: "thread-1",
    });
  });

  it("ignores incomplete or non-string payload data", () => {
    expect(notificationThreadRouteFromData(null)).toBeNull();
    expect(notificationThreadRouteFromData({ hostId: "host-1" })).toBeNull();
    expect(notificationThreadRouteFromData({ threadId: "thread-1" })).toBeNull();
    expect(notificationThreadRouteFromData({ hostId: 1, threadId: "thread-1" })).toBeNull();
  });

  it("normalizes whitespace in thread route data", () => {
    expect(
      notificationThreadRouteFromData({
        hostId: " host-1 ",
        threadId: " thread-1 ",
      }),
    ).toEqual({
      hostId: "host-1",
      threadId: "thread-1",
    });
  });
});

describe("notificationFromDomainEvent", () => {
  it("notifies for completed assistant messages", () => {
    expect(
      notificationFromDomainEvent(
        event({
          type: "thread.message-sent",
          payload: {
            role: "assistant",
            streaming: false,
            text: "Finished the implementation.",
            threadId: "thread-1",
          },
        }),
      ),
    ).toEqual({
      title: "Agent replied",
      body: "Finished the implementation.",
    });
  });

  it("ignores streaming assistant messages and user messages", () => {
    expect(
      notificationFromDomainEvent(
        event({
          type: "thread.message-sent",
          payload: {
            role: "assistant",
            streaming: true,
            text: "partial",
            threadId: "thread-1",
          },
        }),
      ),
    ).toBeNull();
    expect(
      notificationFromDomainEvent(
        event({
          type: "thread.message-sent",
          payload: {
            role: "user",
            streaming: false,
            text: "hello",
            threadId: "thread-1",
          },
        }),
      ),
    ).toBeNull();
  });

  it("notifies for approval and user input requests", () => {
    expect(
      notificationFromDomainEvent(
        event({
          type: "thread.activity-appended",
          payload: {
            activity: {
              kind: "approval.requested",
              summary: "Review command",
            },
          },
        }),
      ),
    ).toEqual({
      title: "Approval needed",
      body: "Review command",
    });

    expect(
      notificationFromDomainEvent(
        event({
          type: "thread.activity-appended",
          payload: {
            activity: {
              kind: "user-input.requested",
              summary: "Choose a target branch",
            },
          },
        }),
      ),
    ).toEqual({
      title: "Input needed",
      body: "Choose a target branch",
    });
  });

  it("notifies for errored sessions", () => {
    expect(
      notificationFromDomainEvent(
        event({
          type: "thread.session-set",
          payload: {
            session: {
              status: "error",
              lastError: "Provider disconnected",
            },
          },
        }),
      ),
    ).toEqual({
      title: "Session needs attention",
      body: "Provider disconnected",
    });

    expect(
      notificationFromDomainEvent(
        event({
          type: "thread.session-set",
          payload: {
            session: {
              status: "running",
              lastError: null,
            },
          },
        }),
      ),
    ).toBeNull();
  });
});
