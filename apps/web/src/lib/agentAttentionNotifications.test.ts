import {
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@ace/contracts";
import { describe, expect, it } from "vitest";

import type { Thread } from "../types";
import {
  buildAgentAttentionDesktopNotificationInput,
  buildAgentAttentionNotificationCopy,
  collectAgentAttentionRequestsToNotify,
  deriveAgentAttentionRequests,
  getAgentAttentionDesktopNotificationBridge,
  isAppWindowFocused,
  readAgentAttentionNotificationPermission,
  requestAgentAttentionNotificationPermission,
  shouldOfferAgentAttentionNotificationPermission,
} from "./agentAttentionNotifications";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  const payload = overrides.payload ?? {};
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-04-06T08:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

function makeThread(input: {
  id: string;
  title: string;
  activities?: OrchestrationThreadActivity[];
}): Thread {
  return {
    id: ThreadId.makeUnsafe(input.id),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: input.title,
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-06T08:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestProposedPlanSummary: null,
    queuedComposerMessages: [],
    queuedSteerRequest: null,
    turnDiffSummaries: [],
    activities: input.activities ?? [],
  };
}

describe("deriveAgentAttentionRequests", () => {
  it("flattens pending approvals and user input requests across threads", () => {
    const requests = deriveAgentAttentionRequests([
      makeThread({
        id: "thread-approval",
        title: "  Build fixes  ",
        activities: [
          makeActivity({
            id: "approval-open",
            createdAt: "2026-04-06T08:00:05.000Z",
            kind: "approval.requested",
            summary: "Command approval requested",
            tone: "approval",
            payload: {
              requestId: "req-approval",
              requestKind: "command",
              detail: "bun run lint",
            },
          }),
        ],
      }),
      makeThread({
        id: "thread-input",
        title: "",
        activities: [
          makeActivity({
            id: "input-open",
            createdAt: "2026-04-06T08:00:01.000Z",
            kind: "user-input.requested",
            summary: "Structured input requested",
            tone: "info",
            payload: {
              requestId: "req-input",
              questions: [
                {
                  id: "scope",
                  header: "Scope",
                  question: "Which scope should the agent handle first?",
                  options: [
                    {
                      label: "Server",
                      description: "Start with the server",
                    },
                  ],
                },
                {
                  id: "tests",
                  header: "Tests",
                  question: "Should tests be included?",
                  options: [
                    {
                      label: "Yes",
                      description: "Add tests",
                    },
                  ],
                },
              ],
            },
          }),
        ],
      }),
    ]);

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.key)).toEqual([
      "thread-input:req-input",
      "thread-approval:req-approval",
    ]);
    expect(requests[0]).toMatchObject({
      threadTitle: "Untitled thread",
      kind: "user-input",
      body: "Which scope should the agent handle first? (2 questions waiting)",
    });
    expect(requests[1]).toMatchObject({
      threadTitle: "Build fixes",
      kind: "approval",
      body: "bun run lint",
    });
  });

  it("uses fallback approval copy when no detail is available", () => {
    const [request] = deriveAgentAttentionRequests([
      makeThread({
        id: "thread-file-read",
        title: "Review",
        activities: [
          makeActivity({
            id: "approval-open",
            kind: "approval.requested",
            summary: "File read approval requested",
            tone: "approval",
            payload: {
              requestId: "req-file-read",
              requestKind: "file-read",
            },
          }),
        ],
      }),
    ]);

    expect(request?.body).toBe("The agent is waiting for file read approval.");
  });
});

describe("buildAgentAttentionNotificationCopy", () => {
  it("builds stable titles and tags for attention notifications", () => {
    const [request] = deriveAgentAttentionRequests([
      makeThread({
        id: "thread-approval",
        title: "Build fixes",
        activities: [
          makeActivity({
            id: "approval-open",
            kind: "approval.requested",
            summary: "Command approval requested",
            tone: "approval",
            payload: {
              requestId: "req-approval",
              requestKind: "command",
              detail: "bun run lint",
            },
          }),
        ],
      }),
    ]);

    expect(buildAgentAttentionNotificationCopy(request!)).toEqual({
      title: "Approval needed: Build fixes",
      body: "bun run lint",
      tag: "ace-agent-attention:thread-approval:req-approval",
    });
  });

  it("builds desktop notification payloads with stable ids", () => {
    const [request] = deriveAgentAttentionRequests([
      makeThread({
        id: "thread-approval",
        title: "Build fixes",
        activities: [
          makeActivity({
            id: "approval-open",
            kind: "approval.requested",
            summary: "Command approval requested",
            tone: "approval",
            payload: {
              requestId: "req-approval",
              requestKind: "command",
              detail: "bun run lint",
            },
          }),
        ],
      }),
    ]);

    expect(buildAgentAttentionDesktopNotificationInput(request!)).toEqual({
      id: "thread-approval:req-approval",
      title: "Approval needed: Build fixes",
      body: "bun run lint",
    });
  });
});

describe("agent attention notification helpers", () => {
  it("only returns unseen requests when the app is not focused", () => {
    const requests = deriveAgentAttentionRequests([
      makeThread({
        id: "thread-1",
        title: "Build fixes",
        activities: [
          makeActivity({
            id: "approval-open",
            createdAt: "2026-04-06T08:00:05.000Z",
            kind: "approval.requested",
            summary: "Command approval requested",
            tone: "approval",
            payload: {
              requestId: "req-approval",
              requestKind: "command",
            },
          }),
          makeActivity({
            id: "input-open",
            createdAt: "2026-04-06T08:00:06.000Z",
            kind: "user-input.requested",
            summary: "Structured input requested",
            tone: "info",
            payload: {
              requestId: "req-input",
              questions: [
                {
                  id: "scope",
                  header: "Scope",
                  question: "Which scope should the agent handle first?",
                  options: [
                    {
                      label: "Server",
                      description: "Start with the server",
                    },
                  ],
                },
              ],
            },
          }),
        ],
      }),
    ]);

    expect(
      collectAgentAttentionRequestsToNotify({
        requests,
        notifiedRequestKeys: new Set(["thread-1:req-approval"]),
        isAppFocused: false,
      }).map((request) => request.key),
    ).toEqual(["thread-1:req-input"]);
    expect(
      collectAgentAttentionRequestsToNotify({
        requests,
        notifiedRequestKeys: new Set<string>(),
        isAppFocused: true,
      }),
    ).toEqual([]);
  });

  it("detects focus and permission prompt eligibility correctly", async () => {
    expect(
      isAppWindowFocused({
        visibilityState: "visible",
        hasFocus: () => true,
      }),
    ).toBe(true);
    expect(
      isAppWindowFocused({
        visibilityState: "hidden",
        hasFocus: () => true,
      }),
    ).toBe(false);

    expect(
      shouldOfferAgentAttentionNotificationPermission({
        permission: "default",
        hasPendingRequests: true,
        isAppFocused: true,
        hasPromptedForPermission: false,
      }),
    ).toBe(true);
    expect(
      shouldOfferAgentAttentionNotificationPermission({
        permission: "granted",
        hasPendingRequests: true,
        isAppFocused: true,
        hasPromptedForPermission: false,
      }),
    ).toBe(false);

    const notificationSource = {
      permission: "default" as const,
      requestPermission: async () => "granted" as const,
    };

    expect(readAgentAttentionNotificationPermission(notificationSource)).toBe("default");
    await expect(requestAgentAttentionNotificationPermission(notificationSource)).resolves.toBe(
      "granted",
    );
    expect(readAgentAttentionNotificationPermission(null)).toBe("unsupported");
    await expect(requestAgentAttentionNotificationPermission(null)).resolves.toBe("unsupported");
  });

  it("detects when the desktop bridge can show native notifications", () => {
    const desktopBridge = {
      showNotification: async () => true,
      closeNotification: async () => true,
      onNotificationClick: () => () => undefined,
    };
    const notificationBridge = getAgentAttentionDesktopNotificationBridge(desktopBridge);

    expect(notificationBridge).not.toBeNull();
    expect(notificationBridge?.showNotification).toBe(desktopBridge.showNotification);
    expect(notificationBridge?.closeNotification).toBe(desktopBridge.closeNotification);
    expect(notificationBridge?.onNotificationClick).toBe(desktopBridge.onNotificationClick);
    expect(getAgentAttentionDesktopNotificationBridge(null)).toBeNull();
    expect(
      getAgentAttentionDesktopNotificationBridge({
        showNotification: async () => true,
        closeNotification: async () => true,
      }),
    ).toBeNull();
  });
});
