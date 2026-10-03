import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, subagent, tool, toolDone, turn } from "./facts.ts";

/**
 * A Codex thread that fans out to two subagents; one of them fails.
 * Labels: `workers-spawned`, `tester-failed`, `done`.
 */
export function failingSubagent(id = "thread-settings"): Scenario {
  return {
    thread: { id, workspaceId: "ace", title: "Migrate settings schema", provider: "codex" },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("codex"),
          turn("root"),
          message(
            "root",
            "ask",
            "user",
            "Move settings to the v2 schema and keep the old reader working.",
          ),
        ],
      },
      {
        kind: "facts",
        delayMs: 800,
        label: "workers-spawned",
        facts: [
          tool("root", "spawn-writer", {
            kind: "agent.spawn",
            title: "Write the v2 schema",
            detail: {
              kind: "agent.spawn",
              description: "Write the v2 schema",
              childAgent: "writer",
            },
          }),
          subagent("codex", "writer", "schema-writer", "spawn-writer"),
          turn("writer", "spawn"),
          tool("root", "spawn-tester", {
            kind: "agent.spawn",
            title: "Test the migration",
            detail: {
              kind: "agent.spawn",
              description: "Run migration tests",
              childAgent: "tester",
            },
          }),
          subagent("codex", "tester", "migration-tester", "spawn-tester"),
          turn("tester", "spawn"),
        ],
      },
      {
        kind: "facts",
        delayMs: 1200,
        label: "tester-failed",
        facts: [
          endTurn("tester", "failed", {
            kind: "provider",
            message: "Context window exceeded while reading fixtures/settings-v1.json",
          }),
          toolDone("root", "spawn-tester", "failed"),
        ],
      },
      {
        kind: "facts",
        delayMs: 1000,
        facts: [
          message(
            "writer",
            "schema",
            "assistant",
            "Added SettingsV2 with a lossless reader for v1 files.",
          ),
          endTurn("writer"),
          toolDone("root", "spawn-writer"),
        ],
      },
      {
        kind: "facts",
        delayMs: 600,
        label: "done",
        facts: [
          message(
            "root",
            "summary",
            "assistant",
            "The schema is migrated. migration-tester failed (context window), so tests still need a run.",
          ),
          endTurn("root"),
        ],
      },
    ],
  };
}
