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
  buildAgentAttentionNotificationTitle,
  buildApprovalNotificationBody,
  buildCompletionNotificationBody,
  buildUserInputNotificationBody,
  normalizeNotificationText,
  shouldForwardDesktopNotificationOrchestrationEvent,
  truncateNotificationText,
} from "./notifications";

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
): Extract<OrchestrationEvent, { type: T }> {
  return {
    sequence: 1,
    eventId: EventId.makeUnsafe("event-1"),
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
  } as Extract<OrchestrationEvent, { type: T }>;
}

describe("notification copy helpers", () => {
  it("builds thread-first attention titles", () => {
    expect(
      buildAgentAttentionNotificationTitle({
        kind: "completion",
        threadTitle: "Build fixes",
      }),
    ).toBe("Build fixes finished");
    expect(
      buildAgentAttentionNotificationTitle({
        kind: "approval",
        threadTitle: "Build fixes",
      }),
    ).toBe("Build fixes needs approval");
    expect(
      buildAgentAttentionNotificationTitle({
        kind: "user-input",
        threadTitle: "",
      }),
    ).toBe("Untitled thread needs input");
  });

  it("normalizes markdown before truncating notification text", () => {
    expect(normalizeNotificationText("Run `[lint](/docs)`   then\n`bun run typecheck`")).toBe(
      "Run lint then bun run typecheck",
    );
    expect(truncateNotificationText("abcdef", 3)).toBe("abc");
  });

  it("builds actionable approval, user-input, and completion bodies", () => {
    expect(
      buildApprovalNotificationBody({
        requestKind: "command",
        detail: "bun lint",
      }),
    ).toBe("Command approval: bun lint");
    expect(
      buildApprovalNotificationBody({
        requestKind: "file-read",
      }),
    ).toBe("Review the file read approval request.");
    expect(
      buildApprovalNotificationBody({
        requestKind: "permission",
        detail: "Use Browser Use",
      }),
    ).toBe("Permission approval: Use Browser Use");
    expect(
      buildApprovalNotificationBody({
        requestKind: "command",
        detail: "bun lint",
        sourceLabel: "Noether Nullguard",
      }),
    ).toBe("From Noether Nullguard - Command approval: bun lint");
    expect(
      buildUserInputNotificationBody({
        firstQuestion: "Which scope should I handle first?",
        questionCount: 2,
      }),
    ).toBe("Which scope should I handle first? (2 questions waiting)");
    expect(buildCompletionNotificationBody({ assistantPreview: "" })).toBe(
      "The agent finished working.",
    );
  });

  it("filters orchestration events before desktop notification IPC", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");

    expect(
      shouldForwardDesktopNotificationOrchestrationEvent(
        makeEvent("thread.message-sent", {
          threadId,
          messageId: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "stream",
          turnId,
          streaming: true,
          createdAt: "2026-04-07T00:00:00.000Z",
          updatedAt: "2026-04-07T00:00:00.000Z",
        }),
      ),
    ).toBe(false);

    expect(
      shouldForwardDesktopNotificationOrchestrationEvent(
        makeEvent("thread.activity-appended", {
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-tool-output"),
            tone: "tool",
            kind: "tool.updated",
            summary: "Command output",
            payload: {},
            turnId,
            createdAt: "2026-04-07T00:00:00.000Z",
          },
        }),
      ),
    ).toBe(false);

    expect(
      shouldForwardDesktopNotificationOrchestrationEvent(
        makeEvent("thread.activity-appended", {
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-approval"),
            tone: "info",
            kind: "approval.requested",
            summary: "Approval requested",
            payload: { requestId: "approval-1", requestKind: "command" },
            turnId,
            createdAt: "2026-04-07T00:00:00.000Z",
          },
        }),
      ),
    ).toBe(true);

    expect(
      shouldForwardDesktopNotificationOrchestrationEvent(
        makeEvent("thread.deleted", {
          threadId,
          deletedAt: "2026-04-07T00:00:00.000Z",
        }),
      ),
    ).toBe(true);
  });
});
