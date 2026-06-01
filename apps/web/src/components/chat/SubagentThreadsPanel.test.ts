import { describe, expect, it } from "vitest";

import { deriveSubagentThreads } from "./SubagentThreadsPanel";
import type { WorkLogEntry } from "../../session-logic/types";

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
