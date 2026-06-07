import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@ace/contracts";
import { describe, expect, it } from "vitest";

import {
  coalesceOrchestrationUiEvents,
  resolveOrchestrationUiEventFlushPriority,
} from "./orchestrationUiEvents";

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  overrides: Partial<Extract<OrchestrationEvent, { type: T }>> = {},
): Extract<OrchestrationEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.makeUnsafe("project-1"),
    occurredAt: "2026-04-07T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

describe("orchestrationUiEvents", () => {
  it("coalesces consecutive message chunks for the same streamed message", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = MessageId.makeUnsafe("message-1");
    const turnId = TurnId.makeUnsafe("turn-1");
    const events = [
      makeEvent("thread.message-sent", {
        threadId,
        messageId,
        role: "assistant",
        text: "hel",
        turnId,
        streaming: true,
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "preview.png",
            mimeType: "image/png",
            sizeBytes: 128,
          },
        ],
        createdAt: "2026-04-07T00:00:00.000Z",
        updatedAt: "2026-04-07T00:00:00.000Z",
      }),
      makeEvent("thread.message-sent", {
        threadId,
        messageId,
        role: "assistant",
        text: "lo",
        turnId,
        streaming: true,
        createdAt: "2026-04-07T00:00:01.000Z",
        updatedAt: "2026-04-07T00:00:01.000Z",
      }),
      makeEvent("thread.message-sent", {
        threadId,
        messageId,
        role: "assistant",
        text: "hello",
        turnId,
        streaming: false,
        createdAt: "2026-04-07T00:00:02.000Z",
        updatedAt: "2026-04-07T00:00:02.000Z",
      }),
    ];

    const coalesced = coalesceOrchestrationUiEvents(events);

    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]?.payload).toMatchObject({
      threadId,
      messageId,
      text: "hello",
      streaming: false,
      createdAt: "2026-04-07T00:00:00.000Z",
      attachments: [
        {
          type: "image",
          id: "attachment-1",
          name: "preview.png",
          mimeType: "image/png",
          sizeBytes: 128,
        },
      ],
    });
  });

  it("flushes streaming updates on animation frames but completes final message state immediately", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");

    expect(
      resolveOrchestrationUiEventFlushPriority(
        makeEvent("thread.message-sent", {
          threadId,
          messageId: MessageId.makeUnsafe("message-streaming"),
          role: "assistant",
          text: "partial",
          turnId,
          streaming: true,
          createdAt: "2026-04-07T00:00:00.000Z",
          updatedAt: "2026-04-07T00:00:00.000Z",
        }),
      ),
    ).toBe("animation-frame");

    expect(
      resolveOrchestrationUiEventFlushPriority(
        makeEvent("thread.message-sent", {
          threadId,
          messageId: MessageId.makeUnsafe("message-final"),
          role: "assistant",
          text: "done",
          turnId,
          streaming: false,
          createdAt: "2026-04-07T00:00:01.000Z",
          updatedAt: "2026-04-07T00:00:01.000Z",
        }),
      ),
    ).toBe("microtask");

    expect(
      resolveOrchestrationUiEventFlushPriority(
        makeEvent("thread.activity-appended", {
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-1"),
            tone: "tool",
            kind: "tool.started",
            summary: "Tool started",
            payload: {},
            turnId,
            createdAt: "2026-04-07T00:00:02.000Z",
          },
        }),
      ),
    ).toBe("animation-frame");

    expect(
      resolveOrchestrationUiEventFlushPriority(
        makeEvent("thread.activity-appended", {
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-completed"),
            tone: "tool",
            kind: "tool.completed",
            summary: "Tool completed",
            payload: {},
            turnId,
            createdAt: "2026-04-07T00:00:03.000Z",
          },
        }),
      ),
    ).toBe("microtask");

    expect(
      resolveOrchestrationUiEventFlushPriority(
        makeEvent("thread.activity-appended", {
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-error"),
            tone: "error",
            kind: "tool.updated",
            summary: "Tool failed",
            payload: {},
            turnId,
            createdAt: "2026-04-07T00:00:04.000Z",
          },
        }),
      ),
    ).toBe("microtask");
  });

  it("coalesces consecutive streamed tool output activity chunks", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");
    const events = [
      makeEvent(
        "thread.activity-appended",
        {
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-output-1"),
            tone: "tool",
            kind: "tool.updated",
            summary: "Command output",
            payload: {
              itemId: "command-1",
              streamKind: "command_output",
              terminalOutput: "total 8\n",
            },
            turnId,
            sequence: 10,
            createdAt: "2026-04-07T00:00:00.000Z",
          },
        },
        { sequence: 10 },
      ),
      makeEvent(
        "thread.activity-appended",
        {
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-output-2"),
            tone: "tool",
            kind: "tool.updated",
            summary: "Command output",
            payload: {
              itemId: "command-1",
              streamKind: "command_output",
              terminalOutput: "drwxr-xr-x .\n",
            },
            turnId,
            sequence: 11,
            createdAt: "2026-04-07T00:00:01.000Z",
          },
        },
        { sequence: 11 },
      ),
    ];

    const coalesced = coalesceOrchestrationUiEvents(events);
    const [event] = coalesced;

    expect(coalesced).toHaveLength(1);
    expect(event?.type).toBe("thread.activity-appended");
    if (event?.type !== "thread.activity-appended") {
      throw new Error("Expected activity event");
    }
    expect(event.sequence).toBe(11);
    expect(event.payload.activity).toMatchObject({
      id: EventId.makeUnsafe("activity-output-2"),
      createdAt: "2026-04-07T00:00:00.000Z",
      sequence: 10,
      payload: {
        itemId: "command-1",
        streamKind: "command_output",
        terminalOutput: "total 8\ndrwxr-xr-x .\n",
      },
    });
  });
});
