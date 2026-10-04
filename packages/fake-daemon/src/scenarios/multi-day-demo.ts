import { DeviceId, type ToolDetail } from "@ace/protocol";
import type { Fact } from "@ace/core";
import type { Scenario, Step } from "../scenario.ts";
import { endTurn, message, output, rootAgent, subagent, tool, toolDone, turn } from "./facts.ts";

/** A modest fake-mode seed spanning five days, with paged turns and real approvals. */
export function multiDayDemo(id = "thread-multi-day", turns = 24): Scenario {
  const steps: Step[] = [];
  const duration = 5 * 24 * 60 * 60 * 1000;
  steps.push({ kind: "facts", agoMs: duration, facts: [rootAgent("codex")] });
  for (let ordinal = 1; ordinal <= turns; ordinal++) {
    const shell = `command-${ordinal}`;
    const edit = `edit-${ordinal}`;
    const facts: Fact[] = [
      message(
        "root",
        `question-${ordinal}`,
        "user",
        `Migrate checkpoint ${ordinal}, inspect files and report failures.`,
      ),
      { type: "turn.started", agent: "root", nativeTurnId: `turn-${ordinal}`, trigger: "user" },
      tool("root", shell, {
        kind: "shell",
        title: `Validate checkpoint ${ordinal}`,
        detail: { kind: "shell", command: `git diff --check checkpoint-${ordinal}` },
      }),
      {
        type: "interaction.opened",
        agent: "root",
        interaction: `approval-${ordinal}`,
        blocking: true,
        item: shell,
        request: {
          kind: "approval",
          title: `Approve checkpoint ${ordinal}`,
          options: [{ id: "allow", label: "Allow once", kind: "allow_once" }],
        },
      },
      {
        type: "interaction.closed",
        interaction: `approval-${ordinal}`,
        state: "resolved",
        resolution: { kind: "approval", optionId: "allow" },
        resolvedBy: DeviceId.parse("fake"),
        autoReviewed: ordinal % 3 === 0,
      },
      output(
        "root",
        shell,
        `Inspecting checkpoint ${ordinal}\n${"dependency scan output ".repeat(300)}\nvalidation ${ordinal % 7 === 0 ? "failed" : "passed"}\n`,
      ),
      {
        type: "item.upsert",
        agent: "root",
        item: shell,
        draft: {
          type: "tool_call",
          complete: true,
          call: {
            status: ordinal % 7 === 0 ? "failed" : "succeeded",
            detail: { kind: "shell", exitCode: ordinal % 7 === 0 ? 1 : 0 },
          },
        },
      },
    ];
    const detail: ToolDetail = {
      kind: "file.edit",
      changes: [
        {
          path: `src/checkpoint-${ordinal % 8}.ts`,
          kind: "update",
          diff: `@@ -1 +1,2 @@\n-old checkpoint\n+checkpoint ${ordinal}\n+verified migration\n`,
        },
      ],
    };
    facts.push(
      tool("root", edit, { kind: "file.edit", title: `Update checkpoint ${ordinal}`, detail }),
      toolDone("root", edit),
    );
    if (ordinal <= 6) {
      const spawn = `spawn-${ordinal}`;
      const worker = `worker-${ordinal}`;
      facts.push(
        tool("root", spawn, {
          kind: "agent.spawn",
          title: `Audit shard ${ordinal}`,
          detail: { kind: "agent.spawn", description: `Audit migration shard ${ordinal}` },
        }),
        subagent("codex", worker, `Migration worker ${ordinal}`, spawn),
        turn(worker),
        message(
          worker,
          `worker-result-${ordinal}`,
          "assistant",
          `Worker ${ordinal} verified subagent-needle migration shard.`,
        ),
        endTurn(worker),
        toolDone("root", spawn),
      );
    }
    for (let item = 1; item <= 70; item++)
      facts.push(
        message(
          "root",
          `scan-${ordinal}-${item}`,
          "assistant",
          `Checkpoint ${ordinal}, dependency ${item}: examined migration and retained original permissions.`,
        ),
      );
    facts.push(
      message(
        "root",
        `answer-${ordinal}`,
        "assistant",
        `Checkpoint ${ordinal} completed. Migration paths validated; ${ordinal % 7 === 0 ? "one command failed and was retried" : "all commands passed"}.`,
      ),
      {
        type: "usage",
        agent: "root",
        inputTokens: 1000,
        outputTokens: 400,
        counterMode: "incremental",
      },
      { type: "turn.ended", agent: "root", nativeTurnId: `turn-${ordinal}`, outcome: "completed" },
    );
    steps.push({
      kind: "facts",
      label: `checkpoint-${ordinal}`,
      agoMs: Math.floor(((turns - ordinal) * duration) / turns),
      facts,
    });
  }
  return {
    thread: {
      id,
      workspaceId: "ace",
      title: "Five-day migration: checkpoints and worker reports",
      provider: "codex",
      permissionMode: "ask",
    },
    steps,
  };
}
