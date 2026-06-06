import { beforeAll, describe, expect, it, vi } from "vitest";

import type { WorkLogEntry } from "../../session-logic/types";
import type { agentThreadsPanelTitle as agentThreadsPanelTitleType } from "./SubagentThreadsPanel";
import type {
  canReplyToSubagentThread as canReplyToSubagentThreadType,
  deriveSubagentThreads as deriveSubagentThreadsType,
  formatSideChatRequestForDisplay as formatSideChatRequestForDisplayType,
  isSideChatThread as isSideChatThreadType,
  orderSubagentThreadsForHierarchy as orderSubagentThreadsForHierarchyType,
  partitionSubagentThreads as partitionSubagentThreadsType,
  resolveSubagentMainAgentMessage as resolveSubagentMainAgentMessageType,
} from "./subagentThreads";

let agentThreadsPanelTitle: typeof agentThreadsPanelTitleType;
let canReplyToSubagentThread: typeof canReplyToSubagentThreadType;
let deriveSubagentThreads: typeof deriveSubagentThreadsType;
let formatSideChatRequestForDisplay: typeof formatSideChatRequestForDisplayType;
let isSideChatThread: typeof isSideChatThreadType;
let orderSubagentThreadsForHierarchy: typeof orderSubagentThreadsForHierarchyType;
let partitionSubagentThreads: typeof partitionSubagentThreadsType;
let resolveSubagentMainAgentMessage: typeof resolveSubagentMainAgentMessageType;

beforeAll(async () => {
  vi.stubGlobal("window", {
    matchMedia: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList: {
        add: vi.fn(),
        remove: vi.fn(),
        toggle: vi.fn(),
      },
    },
  });
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  ({ agentThreadsPanelTitle } = await import("./SubagentThreadsPanel"));
  ({
    canReplyToSubagentThread,
    deriveSubagentThreads,
    formatSideChatRequestForDisplay,
    isSideChatThread,
    orderSubagentThreadsForHierarchy,
    partitionSubagentThreads,
    resolveSubagentMainAgentMessage,
  } = await import("./subagentThreads"));
});

function workEntry(input: Partial<WorkLogEntry> & Pick<WorkLogEntry, "id">): WorkLogEntry {
  return {
    createdAt: "2026-06-02T00:00:00.000Z",
    label: "Subagent task",
    tone: "tool",
    ...input,
  };
}

describe("deriveSubagentThreads", () => {
  it("uses Codex-created agent names instead of the generic Codex fallback", () => {
    const threads = deriveSubagentThreads(
      [
        workEntry({
          id: "created-dewey",
          label: "Created Dewey (explorer) with the instructions:",
          detail: "Audit architecture and runtime risks.",
          subagentId: "child-provider-thread-1",
          subagentType: "codex subagent",
        }),
        workEntry({
          id: "dewey-reasoning",
          createdAt: "2026-06-02T00:00:01.000Z",
          label: "Reasoning",
          detail: "Reading package.json",
          subagentId: "child-provider-thread-1",
          subagentType: "codex subagent",
        }),
      ],
      "codex",
    );

    expect(threads).toHaveLength(1);
    expect(threads[0]?.label).toBe("Dewey");
  });

  it("prefers subagent names supplied by Codex app-server metadata", () => {
    const threads = deriveSubagentThreads(
      [
        workEntry({
          id: "codex-named-agent",
          label: "Reasoning",
          subagentId: "child-provider-thread-1",
          subagentName: "pauli",
          subagentType: "codex subagent",
        }),
      ],
      "codex",
    );

    expect(threads).toHaveLength(1);
    expect(threads[0]?.label).toBe("Pauli");
  });

  it("preserves provider parent relationships for nested agent trees", () => {
    const threads = deriveSubagentThreads(
      [
        workEntry({
          id: "copilot-root-agent",
          createdAt: "2026-06-02T00:00:00.000Z",
          subagentId: "agent-root",
          subagentName: "Runtime Reviewer",
          subagentType: "code-reviewer",
        }),
        workEntry({
          id: "copilot-child-agent",
          createdAt: "2026-06-02T00:00:01.000Z",
          subagentId: "agent-child",
          subagentParentId: "agent-root",
          subagentName: "Docs Writer",
          subagentType: "docs-writer",
        }),
      ],
      "githubCopilot",
    );

    expect(threads.map((thread) => ({ id: thread.id, parentId: thread.parentId }))).toEqual([
      { id: "agent-child", parentId: "agent-root" },
      { id: "agent-root", parentId: undefined },
    ]);
  });

  it("orders nested provider subagents parent-first for shared UI surfaces", () => {
    const threads = deriveSubagentThreads(
      [
        workEntry({
          id: "child",
          createdAt: "2026-06-02T00:00:03.000Z",
          subagentId: "child-agent",
          subagentParentId: "root-agent",
          subagentName: "Child Agent",
          subagentType: "reviewer",
        }),
        workEntry({
          id: "grandchild",
          createdAt: "2026-06-02T00:00:04.000Z",
          subagentId: "grandchild-agent",
          subagentParentId: "child-agent",
          subagentName: "Grandchild Agent",
          subagentType: "reviewer",
        }),
        workEntry({
          id: "root",
          createdAt: "2026-06-02T00:00:01.000Z",
          subagentId: "root-agent",
          subagentName: "Root Agent",
          subagentType: "reviewer",
        }),
      ],
      "githubCopilot",
    );

    expect(
      orderSubagentThreadsForHierarchy(threads).map(({ thread, depth }) => ({
        depth,
        id: thread.id,
      })),
    ).toEqual([
      { depth: 0, id: "root-agent" },
      { depth: 1, id: "child-agent" },
      { depth: 2, id: "grandchild-agent" },
    ]);
  });

  it("removes agent suffixes from supplied subagent names", () => {
    const threads = deriveSubagentThreads(
      [
        workEntry({
          id: "codex-named-agent",
          label: "Reasoning",
          subagentId: "child-provider-thread-1",
          subagentName: "review agent",
          subagentType: "codex subagent",
        }),
      ],
      "codex",
    );

    expect(threads).toHaveLength(1);
    expect(threads[0]?.label).toBe("Review");
  });

  it("resolves the provider-agnostic main-agent handoff message", () => {
    const [thread] = deriveSubagentThreads(
      [
        workEntry({
          id: "main-to-subagent",
          label: "Message sent",
          detail: "Inspect the runtime event flow.",
          subagentId: "child-provider-thread-1",
          subagentName: "review",
          sideChatMessageRole: "user",
          sideChatMessageText: "Inspect the runtime event flow.",
        }),
        workEntry({
          id: "subagent-response",
          createdAt: "2026-06-02T00:00:01.000Z",
          label: "Assistant response",
          detail: "I will inspect the flow.",
          subagentId: "child-provider-thread-1",
          subagentName: "review",
          sideChatMessageRole: "assistant",
          sideChatMessageText: "I will inspect the flow.",
        }),
      ],
      "codex",
    );

    expect(thread).toBeDefined();
    expect(resolveSubagentMainAgentMessage(thread!)?.sideChatMessageText).toBe(
      "Inspect the runtime event flow.",
    );
  });

  it("keeps multiple native side chats as distinct side-chat threads", () => {
    const threads = deriveSubagentThreads(
      [
        workEntry({
          id: "side-one-user",
          detail: "Explain the current branch.",
          subagentId: "side:thread-1:first",
          subagentType: "side chat",
          sideChatMessageRole: "user",
          sideChatMessageText: "Explain the current branch.",
        }),
        workEntry({
          id: "side-two-user",
          createdAt: "2026-06-02T00:00:01.000Z",
          detail: "Check the recent diff.",
          subagentId: "side:thread-1:second",
          subagentType: "side chat",
          sideChatMessageRole: "user",
          sideChatMessageText: "Check the recent diff.",
        }),
      ],
      "claudeAgent",
    );

    expect(threads).toHaveLength(2);
    expect(threads.every(isSideChatThread)).toBe(true);
    expect(threads.map((thread) => thread.label).toSorted()).toEqual([
      "Check the recent diff.",
      "Explain the current branch.",
    ]);
  });

  it("partitions side chats separately from provider subagent threads", () => {
    const threads = deriveSubagentThreads(
      [
        workEntry({
          id: "provider-subagent",
          subagentId: "agent-reviewer",
          subagentName: "Reviewer",
          subagentType: "code-reviewer",
        }),
        workEntry({
          id: "side-chat",
          createdAt: "2026-06-02T00:00:01.000Z",
          detail: "Explain the current branch.",
          subagentId: "side:thread-1:first",
          subagentType: "side chat",
          sideChatMessageRole: "user",
          sideChatMessageText: "Explain the current branch.",
        }),
      ],
      "githubCopilot",
    );

    expect(partitionSubagentThreads(threads)).toMatchObject({
      providerSubagentThreads: [{ id: "agent-reviewer", label: "Reviewer" }],
      sideChatThreads: [{ id: "side:thread-1:first", label: "Explain the current branch." }],
    });
  });

  it("labels the compact panel by the visible thread mix", () => {
    const sideThreads = deriveSubagentThreads(
      [
        workEntry({
          id: "side-chat",
          subagentId: "side:thread-1:first",
          subagentType: "side chat",
          sideChatMessageRole: "user",
          sideChatMessageText: "Explain the current branch.",
        }),
      ],
      "codex",
    );
    const subagentThreads = deriveSubagentThreads(
      [
        workEntry({
          id: "provider-subagent",
          subagentId: "agent-reviewer",
          subagentName: "Reviewer",
          subagentType: "code-reviewer",
        }),
      ],
      "githubCopilot",
    );

    expect(agentThreadsPanelTitle(sideThreads)).toBe("Side chats");
    expect(agentThreadsPanelTitle(subagentThreads)).toBe("Subagents");
    expect(agentThreadsPanelTitle([...sideThreads, ...subagentThreads])).toBe("Agent chats");
  });

  it("keeps multiple provider child side chats with the same agent as distinct threads", () => {
    const threads = deriveSubagentThreads(
      [
        workEntry({
          id: "provider-side-one-user",
          detail: "Review the API route.",
          subagentId: "provider-child-session-a",
          subagentName: "Reviewer",
          subagentType: "side-chat",
          sideChatMessageRole: "user",
          sideChatMessageText: "Review the API route.",
        }),
        workEntry({
          id: "provider-side-two-user",
          createdAt: "2026-06-02T00:00:01.000Z",
          detail: "Review the worker route.",
          subagentId: "provider-child-session-b",
          subagentName: "Reviewer",
          subagentType: "side_chat",
          sideChatMessageRole: "user",
          sideChatMessageText: "Review the worker route.",
        }),
      ],
      "opencode",
    );

    expect(threads).toHaveLength(2);
    expect(threads.every(isSideChatThread)).toBe(true);
    expect(threads.map((thread) => thread.id).toSorted()).toEqual([
      "provider-child-session-a",
      "provider-child-session-b",
    ]);
    expect(threads.map((thread) => thread.label).toSorted()).toEqual([
      "Review the API route.",
      "Review the worker route.",
    ]);
  });

  it("recognizes provider btw side chats as side-chat threads", () => {
    const threads = deriveSubagentThreads(
      [
        workEntry({
          id: "provider-btw-user",
          detail: "Check the current context quietly.",
          subagentId: "provider-btw-session",
          subagentName: "Context side chat",
          subagentType: "btw",
          sideChatMessageRole: "user",
          sideChatMessageText: "Check the current context quietly.",
        }),
      ],
      "claudeAgent",
    );

    expect(threads).toHaveLength(1);
    expect(isSideChatThread(threads[0]!)).toBe(true);
    expect(threads[0]?.label).toBe("Check the current context quietly.");
  });

  it("recognizes provider side-chat command text when metadata is generic", () => {
    const threads = deriveSubagentThreads(
      [
        workEntry({
          id: "provider-side-command-user",
          detail: ".side Check the current provider context quietly.",
          subagentId: "provider-child-session-side",
          subagentName: "Context helper",
          subagentType: "subagent",
          sideChatMessageRole: "user",
          sideChatMessageText: ".side Check the current provider context quietly.",
        }),
      ],
      "codex",
    );

    expect(threads).toHaveLength(1);
    expect(isSideChatThread(threads[0]!)).toBe(true);
    expect(threads[0]?.label).toBe("Check the current provider context quietly.");
    expect(partitionSubagentThreads(threads)).toMatchObject({
      providerSubagentThreads: [],
      sideChatThreads: [{ id: "provider-child-session-side" }],
    });
  });

  it("does not merge side chats that only have generic side-chat metadata", () => {
    const threads = deriveSubagentThreads(
      [
        workEntry({
          id: "side-one-user",
          detail: "Review the first route.",
          subagentType: "side chat",
          sideChatMessageId: "side-one-message",
          sideChatMessageRole: "user",
          sideChatMessageText: "Review the first route.",
        }),
        workEntry({
          id: "side-two-user",
          createdAt: "2026-06-02T00:00:01.000Z",
          detail: "Review the second route.",
          subagentType: "side chat",
          sideChatMessageId: "side-two-message",
          sideChatMessageRole: "user",
          sideChatMessageText: "Review the second route.",
        }),
      ],
      "gemini",
    );

    expect(threads).toHaveLength(2);
    expect(threads.every(isSideChatThread)).toBe(true);
    expect(threads.map((thread) => thread.id).toSorted()).toEqual([
      "side-one-message",
      "side-two-message",
    ]);
  });

  it("groups side-chat messages by provider conversation id when no child thread id exists", () => {
    const threads = deriveSubagentThreads(
      [
        workEntry({
          id: "side-user",
          detail: "Review the current route.",
          subagentId: "provider-side-conversation-1",
          subagentType: "side chat",
          sideChatMessageId: "side-user-message",
          sideChatMessageRole: "user",
          sideChatMessageText: "Review the current route.",
        }),
        workEntry({
          id: "side-assistant",
          createdAt: "2026-06-02T00:00:01.000Z",
          detail: "The route uses the provider command reactor.",
          subagentId: "provider-side-conversation-1",
          subagentType: "side chat",
          sideChatMessageId: "side-assistant-message",
          sideChatMessageRole: "assistant",
          sideChatMessageText: "The route uses the provider command reactor.",
        }),
      ],
      "gemini",
    );

    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe("provider-side-conversation-1");
    expect(threads[0]?.label).toBe("Review the current route.");
    expect(threads[0]?.entries.map((entry) => entry.sideChatMessageRole)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("keeps side chats from the same provider agent separate by side conversation id", () => {
    const threads = deriveSubagentThreads(
      [
        workEntry({
          id: "same-agent-side-one",
          subagentId: "side-conversation-review-api",
          subagentName: "Reviewer",
          subagentType: "side chat",
          sideChatMessageRole: "user",
          sideChatMessageText: "Review the API route.",
        }),
        workEntry({
          id: "same-agent-side-two",
          createdAt: "2026-06-02T00:00:01.000Z",
          subagentId: "side-conversation-review-worker",
          subagentName: "Reviewer",
          subagentType: "side chat",
          sideChatMessageRole: "user",
          sideChatMessageText: "Review the worker route.",
        }),
      ],
      "githubCopilot",
    );

    expect(threads).toHaveLength(2);
    expect(threads.every(isSideChatThread)).toBe(true);
    expect(threads.map((thread) => thread.id).toSorted()).toEqual([
      "side-conversation-review-api",
      "side-conversation-review-worker",
    ]);
  });

  it("does not merge provider subagent threads that share an agent name", () => {
    const threads = deriveSubagentThreads(
      [
        workEntry({
          id: "opencode-subtask-one",
          subagentId: "opencode-child-session-1",
          subagentName: "scout",
          subagentType: "opencode subagent",
          subagentModel: "openai/gpt-5",
        }),
        workEntry({
          id: "opencode-subtask-two",
          createdAt: "2026-06-02T00:00:01.000Z",
          subagentId: "opencode-child-session-2",
          subagentName: "scout",
          subagentType: "opencode subagent",
          subagentModel: "openai/gpt-5",
        }),
      ],
      "opencode",
    );

    expect(threads).toHaveLength(2);
    expect(threads.map((thread) => thread.id).toSorted()).toEqual([
      "opencode-child-session-1",
      "opencode-child-session-2",
    ]);
    expect(threads.map((thread) => thread.label)).toEqual(["Scout", "Scout"]);
  });

  it("titles side chats from the first user request", () => {
    const [thread] = deriveSubagentThreads(
      [
        workEntry({
          id: "side-user",
          detail: "/btw Inspect provider handoff behavior across adapters.",
          subagentId: "side:thread-1:first",
          subagentType: "side chat",
          sideChatMessageRole: "user",
          sideChatMessageText: "/btw Inspect provider handoff behavior across adapters.",
        }),
        workEntry({
          id: "side-assistant",
          createdAt: "2026-06-02T00:00:01.000Z",
          detail: "I will inspect the adapters.",
          subagentId: "side:thread-1:first",
          subagentType: "side chat",
          sideChatMessageRole: "assistant",
          sideChatMessageText: "I will inspect the adapters.",
        }),
      ],
      "codex",
    );

    expect(thread?.label).toBe("Inspect provider handoff behavior across adapters.");
  });

  it("removes provider effort prefixes from side-chat labels", () => {
    const [thread] = deriveSubagentThreads(
      [
        workEntry({
          id: "side-user",
          detail: "Ultrathink:\nExplain the replay context.",
          subagentId: "side:thread-1:ultra",
          subagentType: "side chat",
          sideChatMessageRole: "user",
          sideChatMessageText: "Ultrathink:\nExplain the replay context.",
        }),
      ],
      "claudeAgent",
    );

    expect(thread?.label).toBe("Explain the replay context.");
  });

  it("formats provider side-chat request text for panel display", () => {
    expect(formatSideChatRequestForDisplay("/btw Inspect provider handoff behavior.")).toBe(
      "Inspect provider handoff behavior.",
    );
    expect(formatSideChatRequestForDisplay("Ultrathink:\n/side Explain the branch.")).toBe(
      "Explain the branch.",
    );
  });

  it("allows replies only for side chats or natively targetable provider subagents", () => {
    const [sideThread] = deriveSubagentThreads(
      [
        workEntry({
          id: "side-user",
          subagentId: "side:thread-1:first",
          subagentType: "side chat",
          sideChatMessageRole: "user",
          sideChatMessageText: "Explain the current branch.",
        }),
      ],
      "codex",
    );
    const [providerThread] = deriveSubagentThreads(
      [
        workEntry({
          id: "provider-subagent",
          subagentId: "provider-child-thread-1",
          subagentName: "review",
          subagentType: "code-reviewer",
        }),
      ],
      "claudeAgent",
    );

    expect(sideThread).toBeDefined();
    expect(providerThread).toBeDefined();
    expect(canReplyToSubagentThread(sideThread!, "unsupported")).toBe(true);
    expect(canReplyToSubagentThread(providerThread!, "unsupported")).toBe(false);
    expect(canReplyToSubagentThread(providerThread!, "native")).toBe(true);
  });

  it("generates a stable parody name for generic subagent identities", () => {
    const first = deriveSubagentThreads(
      [
        workEntry({
          id: "generic-created",
          label: "Reasoning",
          subagentId: "child-provider-thread-99",
          subagentType: "codex subagent",
        }),
      ],
      "codex",
    );
    const second = deriveSubagentThreads(
      [
        workEntry({
          id: "generic-created-again",
          label: "Reasoning",
          subagentId: "child-provider-thread-99",
          subagentType: "codex subagent",
        }),
      ],
      "codex",
    );

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.label).toBe(second[0]?.label);
    expect(first[0]?.label).toMatch(/\w+ \w+/);
    expect(first[0]?.label).not.toMatch(/ Agent$/);
    expect(first[0]?.label).not.toBe("Codex Subagent");
    expect(first[0]?.persona).toMatchObject({
      initials: expect.any(String),
      name: first[0]?.label,
    });
  });

  it("keeps generated generic subagent names unique within a thread", () => {
    const threads = deriveSubagentThreads(
      [
        workEntry({
          id: "generic-created-one",
          label: "Reasoning",
          subagentId: "child-provider-thread-99",
          subagentType: "codex subagent",
        }),
        workEntry({
          id: "generic-created-two",
          label: "Reasoning",
          subagentId: "child-provider-thread-100",
          subagentType: "codex subagent",
        }),
      ],
      "codex",
    );

    expect(threads).toHaveLength(2);
    expect(new Set(threads.map((thread) => thread.label))).toHaveLength(2);
  });

  it("marks subagent threads completed when the latest status is completed", () => {
    const threads = deriveSubagentThreads([
      workEntry({
        id: "started",
        status: "inProgress",
        subagentId: "agent-1",
        subagentType: "code-reviewer",
      }),
      workEntry({
        id: "completed",
        createdAt: "2026-06-02T00:00:01.000Z",
        status: "completed",
        subagentId: "agent-1",
        subagentType: "code-reviewer",
      }),
    ]);

    expect(threads[0]?.status).toBe("completed");
  });

  it("marks side-chat threads running when a later turn is in progress", () => {
    const threads = deriveSubagentThreads([
      workEntry({
        id: "side-first-completed",
        status: "completed",
        subagentId: "side:thread-1:reopened",
        subagentType: "side chat",
        sideChatMessageRole: "assistant",
        sideChatMessageText: "The first check is complete.",
      }),
      workEntry({
        id: "side-second-running",
        createdAt: "2026-06-02T00:00:01.000Z",
        status: "inProgress",
        subagentId: "side:thread-1:reopened",
        subagentType: "side chat",
        sideChatMessageRole: "user",
        sideChatMessageText: "Keep watching the build.",
      }),
    ]);

    expect(threads[0]?.status).toBe("running");
  });

  it("does not keep a recovered subagent failed after a later completed status", () => {
    const threads = deriveSubagentThreads([
      workEntry({
        id: "failed-first",
        status: "failed",
        tone: "error",
        subagentId: "agent-1",
        subagentType: "code-reviewer",
      }),
      workEntry({
        id: "completed-later",
        createdAt: "2026-06-02T00:00:01.000Z",
        status: "completed",
        subagentId: "agent-1",
        subagentType: "code-reviewer",
      }),
    ]);

    expect(threads[0]?.status).toBe("completed");
  });

  it("keeps provider-specific subagent types for non-Codex providers", () => {
    const threads = deriveSubagentThreads(
      [
        workEntry({
          id: "claude-reviewer",
          label: "Subagent task",
          subagentId: "agent-1",
          subagentType: "code-reviewer",
          subagentModel: "claude-sonnet",
        }),
      ],
      "claudeAgent",
    );

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      label: "Code Reviewer",
      model: "claude-sonnet",
    });
  });
});
