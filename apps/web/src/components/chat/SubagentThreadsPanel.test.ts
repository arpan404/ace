import { beforeAll, describe, expect, it, vi } from "vitest";

import type { WorkLogEntry } from "../../session-logic/types";
import type {
  canReplyToSubagentThread as canReplyToSubagentThreadType,
  deriveSubagentThreads as deriveSubagentThreadsType,
  isSideChatThread as isSideChatThreadType,
  resolveSubagentMainAgentMessage as resolveSubagentMainAgentMessageType,
} from "./subagentThreads";

let canReplyToSubagentThread: typeof canReplyToSubagentThreadType;
let deriveSubagentThreads: typeof deriveSubagentThreadsType;
let isSideChatThread: typeof isSideChatThreadType;
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
  ({
    canReplyToSubagentThread,
    deriveSubagentThreads,
    isSideChatThread,
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
      "Side chat 1",
      "Side chat 2",
    ]);
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
