import { describe, expect, it } from "vitest";

import type { WorkLogEntry } from "../../session-logic/types";
import { agentThreadsAddTabLabel, type SubagentThread } from "./subagentThreads";

function entry(overrides: Partial<WorkLogEntry> & Pick<WorkLogEntry, "id">): WorkLogEntry {
  return {
    createdAt: "2026-06-02T00:00:00.000Z",
    label: "Agent message",
    tone: "thinking",
    ...overrides,
  };
}

function thread(overrides: Partial<SubagentThread> = {}): SubagentThread {
  return {
    id: "agent-1",
    label: "Reviewer",
    persona: {
      avatarClassName: "",
      haloClassName: "",
      initials: "RV",
      name: "Reviewer",
      pingClassName: "",
    },
    status: "completed",
    entries: [
      entry({
        id: "entry-1",
        subagentId: "agent-1",
        subagentName: "Reviewer",
      }),
    ],
    ...overrides,
  };
}

describe("agentThreadsAddTabLabel", () => {
  it("does not expose a subagent add-tab item without threads", () => {
    expect(agentThreadsAddTabLabel([])).toBeNull();
  });

  it("labels provider subagent threads", () => {
    expect(agentThreadsAddTabLabel([thread()])).toBe("Subagents");
  });

  it("labels side-chat-only threads", () => {
    expect(
      agentThreadsAddTabLabel([
        thread({
          id: "side:thread-1:first",
          label: "Explain current context",
          entries: [
            entry({
              id: "entry-side",
              subagentId: "side:thread-1:first",
              subagentType: "side chat",
              sideChatMessageRole: "user",
              sideChatMessageText: "/side Explain current context",
            }),
          ],
        }),
      ]),
    ).toBe("Side chats");
  });

  it("labels mixed side chats and provider subagents as agent chats", () => {
    const sideThread = thread({
      id: "side:thread-1:first",
      label: "Explain current context",
      entries: [
        entry({
          id: "entry-side",
          subagentId: "side:thread-1:first",
          subagentType: "side chat",
          sideChatMessageRole: "user",
          sideChatMessageText: "/side Explain current context",
        }),
      ],
    });

    expect(agentThreadsAddTabLabel([thread(), sideThread])).toBe("Agent chats");
  });
});
