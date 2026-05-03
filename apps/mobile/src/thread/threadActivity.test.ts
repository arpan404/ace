import { describe, expect, it } from "vitest";
import { EventId, type OrchestrationThreadActivity } from "@ace/contracts";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  parseUserInputQuestions,
} from "./threadActivity";

const NOW = "2026-05-02T00:00:00.000Z";

function activity(
  input: Omit<Partial<OrchestrationThreadActivity>, "id" | "kind" | "payload"> & {
    readonly id: string;
    readonly kind: string;
    readonly payload: unknown;
  },
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(input.id),
    tone: input.tone ?? "info",
    kind: input.kind,
    summary: input.summary ?? input.kind,
    payload: input.payload,
    turnId: input.turnId ?? null,
    sequence: input.sequence,
    createdAt: input.createdAt ?? NOW,
  };
}

describe("threadActivity", () => {
  it("keeps only unresolved approvals in sequence order", () => {
    const pending = derivePendingApprovals([
      activity({
        id: "resolve-later",
        kind: "approval.resolved",
        sequence: 4,
        payload: { requestId: "req-resolved" },
      }),
      activity({
        id: "request-open",
        kind: "approval.requested",
        sequence: 3,
        summary: "Run deploy",
        payload: {
          requestId: "req-open",
          requestType: "exec",
          detail: "bun run deploy",
        },
      }),
      activity({
        id: "request-resolved",
        kind: "approval.requested",
        sequence: 1,
        summary: "Read secrets",
        payload: {
          requestId: "req-resolved",
          requestKind: "file-read",
          detail: "/tmp/secret",
        },
      }),
    ]);

    expect(pending).toEqual([
      {
        requestId: "req-open",
        kind: "command",
        summary: "Run deploy",
        detail: "bun run deploy",
        createdAt: NOW,
      },
    ]);
  });

  it("treats failed approval responses as no longer pending", () => {
    const pending = derivePendingApprovals([
      activity({
        id: "request",
        kind: "approval.requested",
        payload: { requestId: "req-failed", requestType: "patch" },
      }),
      activity({
        id: "failed",
        kind: "provider.approval.respond.failed",
        payload: { requestId: "req-failed" },
      }),
    ]);

    expect(pending).toEqual([]);
  });

  it("parses valid user-input questions and skips malformed entries", () => {
    expect(
      parseUserInputQuestions({
        questions: [
          null,
          { id: "missing-prompt" },
          {
            id: "target",
            header: "Target",
            question: "Where should this run?",
            options: [{ label: "Server", description: "Remote host" }, { label: "Web" }, {}],
          },
          {
            question: "Select checks",
            options: [{ label: "lint" }, { label: "typecheck" }],
            multiSelect: true,
          },
        ],
      }),
    ).toEqual([
      {
        id: "target",
        header: "Target",
        question: "Where should this run?",
        options: [
          { label: "Server", description: "Remote host" },
          { label: "Web", description: "Web" },
        ],
      },
      {
        id: "question-4",
        header: "Question 4",
        question: "Select checks",
        options: [
          { label: "lint", description: "lint" },
          { label: "typecheck", description: "typecheck" },
        ],
        multiSelect: true,
      },
    ]);
  });

  it("removes resolved and stale user-input requests", () => {
    const pending = derivePendingUserInputs([
      activity({
        id: "open",
        kind: "user-input.requested",
        sequence: 1,
        payload: {
          requestId: "req-open",
          questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }],
        },
      }),
      activity({
        id: "stale",
        kind: "user-input.requested",
        sequence: 2,
        payload: {
          requestId: "req-stale",
          questions: [{ id: "q", question: "Old?", options: [{ label: "No" }] }],
        },
      }),
      activity({
        id: "stale-failed",
        kind: "provider.user-input.respond.failed",
        sequence: 3,
        payload: {
          requestId: "req-stale",
          detail: "Stale pending user-input request",
        },
      }),
      activity({
        id: "resolved",
        kind: "user-input.requested",
        sequence: 4,
        payload: {
          requestId: "req-resolved",
          questions: [{ id: "q", question: "Done?", options: [] }],
        },
      }),
      activity({
        id: "resolved-event",
        kind: "user-input.resolved",
        sequence: 5,
        payload: { requestId: "req-resolved" },
      }),
    ]);

    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestId).toBe("req-open");
    expect(pending[0]?.questions[0]?.question).toBe("Continue?");
  });
});
