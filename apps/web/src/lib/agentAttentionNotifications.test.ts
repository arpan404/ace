import {
  MessageId,
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
  filterAgentAttentionRequestsBySettings,
  getAgentAttentionDesktopNotificationBridge,
  isAppWindowFocused,
  readAgentAttentionNotificationPermission,
  resolveAgentAttentionNotificationReply,
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
  latestTurn?: Thread["latestTurn"];
  messages?: Thread["messages"];
  session?: Thread["session"];
}): Thread {
  return {
    id: ThreadId.makeUnsafe(input.id),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    kind: "coding",
    title: input.title,
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: input.session ?? null,
    messages: input.messages ?? [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-06T08:00:00.000Z",
    archivedAt: null,
    latestTurn: input.latestTurn ?? null,
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
      body: "Command approval: bun run lint",
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

    expect(request?.body).toBe("Review the file read approval request.");
  });

  it("includes completed turns with a stable key and assistant preview", () => {
    const [request] = deriveAgentAttentionRequests([
      makeThread({
        id: "thread-complete",
        title: "Ship it",
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-04-06T08:00:00.000Z",
          startedAt: "2026-04-06T08:00:01.000Z",
          completedAt: "2026-04-06T08:00:09.000Z",
          assistantMessageId: MessageId.makeUnsafe("msg-1"),
        },
        messages: [
          {
            id: MessageId.makeUnsafe("msg-1"),
            role: "assistant",
            text: "Finished wiring the notification bridge and inline reply handling.",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-04-06T08:00:02.000Z",
            completedAt: "2026-04-06T08:00:09.000Z",
            streaming: false,
          },
        ],
      }),
    ]);

    expect(request).toMatchObject({
      key: "thread-complete:completion:2026-04-06T08:00:09.000Z",
      kind: "completion",
      body: "Finished wiring the notification bridge and inline reply handling.",
      deepLink: "/thread-complete",
    });
  });

  it("suppresses completion notifications while a session is still running", () => {
    const requests = deriveAgentAttentionRequests([
      makeThread({
        id: "thread-running",
        title: "Ship it",
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-running"),
          state: "completed",
          requestedAt: "2026-04-06T08:00:00.000Z",
          startedAt: "2026-04-06T08:00:01.000Z",
          completedAt: "2026-04-06T08:00:09.000Z",
          assistantMessageId: MessageId.makeUnsafe("msg-running"),
        },
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-running"),
          createdAt: "2026-04-06T08:00:00.000Z",
          updatedAt: "2026-04-06T08:00:09.000Z",
        },
        messages: [
          {
            id: MessageId.makeUnsafe("msg-running"),
            role: "assistant",
            text: "Interim note before continuing tool calls.",
            turnId: TurnId.makeUnsafe("turn-running"),
            createdAt: "2026-04-06T08:00:02.000Z",
            completedAt: "2026-04-06T08:00:09.000Z",
            streaming: false,
          },
        ],
      }),
    ]);

    expect(requests).toEqual([]);
  });

  it("normalizes markdown and whitespace in notification copy", () => {
    const [request] = deriveAgentAttentionRequests([
      makeThread({
        id: "thread-formatting",
        title: "Formatting",
        activities: [
          makeActivity({
            id: "approval-formatting",
            kind: "approval.requested",
            summary: "approval requested",
            tone: "approval",
            payload: {
              requestId: "req-formatting",
              requestKind: "command",
              detail: "Run `[lint](/docs)`   then\n`bun run typecheck`",
            },
          }),
        ],
      }),
    ]);

    expect(request?.body).toBe("Command approval: Run lint then bun run typecheck");
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
      title: "Build fixes needs approval",
      body: "Command approval: bun run lint",
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
      title: "Build fixes needs approval",
      body: "Command approval: bun run lint",
      deepLink: "/thread-approval",
    });
  });

  it("adds inline reply metadata for single-question user input notifications", () => {
    const [request] = deriveAgentAttentionRequests([
      makeThread({
        id: "thread-input",
        title: "Build fixes",
        activities: [
          makeActivity({
            id: "input-open",
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
                    {
                      label: "Web",
                      description: "Start with the web app",
                    },
                  ],
                },
              ],
            },
          }),
        ],
      }),
    ]);

    expect(buildAgentAttentionDesktopNotificationInput(request!)).toEqual({
      id: "thread-input:req-input",
      title: "Build fixes needs input",
      body: "Which scope should the agent handle first?",
      deepLink: "/thread-input",
      reply: {
        placeholder: "Reply with Server, Web",
      },
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

  it("filters requests by the notification settings toggles", () => {
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
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-04-06T08:00:00.000Z",
          startedAt: "2026-04-06T08:00:01.000Z",
          completedAt: "2026-04-06T08:00:09.000Z",
          assistantMessageId: null,
        },
      }),
    ]);

    expect(
      filterAgentAttentionRequestsBySettings(requests, {
        notifyOnAgentCompletion: false,
        notifyOnApprovalRequired: true,
        notifyOnUserInputRequired: false,
      }).map((request) => request.kind),
    ).toEqual(["approval"]);
  });

  it("suppresses historical completion notifications from before the current notification session", () => {
    const requests = deriveAgentAttentionRequests([
      makeThread({
        id: "thread-complete",
        title: "Build fixes",
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-04-06T08:00:00.000Z",
          startedAt: "2026-04-06T08:00:01.000Z",
          completedAt: "2026-04-06T08:00:02.000Z",
          assistantMessageId: null,
        },
      }),
    ]);

    expect(
      collectAgentAttentionRequestsToNotify({
        requests,
        notifiedRequestKeys: new Set<string>(),
        isAppFocused: false,
        notificationSessionStartedAt: "2026-04-06T08:00:03.000Z",
      }),
    ).toEqual([]);
  });

  it("suppresses approval and input requests created before the current background session", () => {
    const requests = deriveAgentAttentionRequests([
      makeThread({
        id: "thread-stale",
        title: "Build fixes",
        activities: [
          makeActivity({
            id: "approval-stale",
            createdAt: "2026-04-06T08:00:00.000Z",
            kind: "approval.requested",
            summary: "Command approval requested",
            tone: "approval",
            payload: {
              requestId: "req-stale-approval",
              requestKind: "command",
              detail: "bun run lint",
            },
          }),
          makeActivity({
            id: "input-recent",
            createdAt: "2026-04-06T08:25:00.000Z",
            kind: "user-input.requested",
            summary: "Structured input requested",
            tone: "info",
            payload: {
              requestId: "req-recent-input",
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
        notifiedRequestKeys: new Set<string>(),
        isAppFocused: false,
        notificationSessionStartedAt: "2026-04-06T08:30:00.000Z",
      }).map((request) => request.key),
    ).toEqual([]);
  });

  it("can allow recent historical requests when an explicit threshold is provided", () => {
    const requests = deriveAgentAttentionRequests([
      makeThread({
        id: "thread-recent",
        title: "Build fixes",
        activities: [
          makeActivity({
            id: "approval-recent",
            createdAt: "2026-04-06T08:24:30.000Z",
            kind: "approval.requested",
            summary: "Command approval requested",
            tone: "approval",
            payload: {
              requestId: "req-recent-approval",
              requestKind: "command",
              detail: "bun run lint",
            },
          }),
        ],
      }),
    ]);

    expect(
      collectAgentAttentionRequestsToNotify({
        requests,
        notifiedRequestKeys: new Set<string>(),
        isAppFocused: false,
        notificationSessionStartedAt: "2026-04-06T08:30:00.000Z",
        historicalRequestThresholdMs: 10 * 60 * 1000,
      }).map((request) => request.key),
    ).toEqual(["thread-recent:req-recent-approval"]);
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
      onNotificationReply: () => () => undefined,
    };
    const notificationBridge = getAgentAttentionDesktopNotificationBridge(desktopBridge);

    expect(notificationBridge).not.toBeNull();
    expect(notificationBridge?.showNotification).toBe(desktopBridge.showNotification);
    expect(notificationBridge?.closeNotification).toBe(desktopBridge.closeNotification);
    expect(notificationBridge?.onNotificationClick).toBe(desktopBridge.onNotificationClick);
    expect(notificationBridge?.onNotificationReply).toBe(desktopBridge.onNotificationReply);
    expect(getAgentAttentionDesktopNotificationBridge(null)).toBeNull();
    expect(
      getAgentAttentionDesktopNotificationBridge({
        showNotification: async () => true,
        closeNotification: async () => true,
      }),
    ).toBeNull();
  });

  it("parses single-question notification replies into orchestration answers", () => {
    const [request] = deriveAgentAttentionRequests([
      makeThread({
        id: "thread-input",
        title: "Build fixes",
        activities: [
          makeActivity({
            id: "input-open",
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

    expect(resolveAgentAttentionNotificationReply(request!, "Server")).toEqual({
      answers: {
        scope: "Server",
      },
    });
  });
});
