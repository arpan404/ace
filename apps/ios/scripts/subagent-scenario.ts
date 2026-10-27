import type { Fact } from "@ace/core";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import { blockedCard, deliveredCard } from "./offshift-card.ts";

/*
 * Subagents to inspect on the phone (no provider CLI runs):
 * - `ios-subagents`: a root that launched four native subagents with prompts. One failed, one
 *   waits for a usage limit to reset (unfinished, never working), one
 *   was stopped, and one finished its own turn while a subagent under it still works and asks
 *   the person a question, so its branch waits on the person and never reads done.
 * - `ios-big-tree`: 160 finished subagents, two still working, and 45 background commands, for
 *   the Agents sheet's pages.
 * `ios-subagents` carries an Offshift run held by a blocker; `ios-big-tree` one in delivery that
 * must read Working while its two subagents still work.
 */

function launch(item: string, name: string, prompt: string): Fact[] {
  return [
    facts.tool("root", item, {
      kind: "agent.spawn",
      title: name,
      detail: { kind: "agent.spawn", description: name, prompt },
    }),
    facts.toolDone("root", item),
  ];
}

const auditPrompt = [
  "Audit every place the daemon kills a process group.",
  "",
  "For each call site, check that the group id was recorded by this daemon and that the process",
  "start time still matches before signalling. List any site that could signal a reused PID,",
  "with the file and line, and say how to fix it.",
].join("\n");

export function seedSubagents(daemon: FakeDaemon): void {
  daemon.apply("ios-subagents", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Harden process cleanup before the release."),
    ...launch("spawn-audit", "Audit kill sites", auditPrompt),
    ...launch("spawn-migrate", "Migrate owner table", "Move owned-process rows to the new table."),
    ...launch(
      "spawn-lint",
      "Lint the CLI",
      "Run the linter on apps/daemon/src/cli and fix what it finds.",
    ),
    facts.subagent("claude", "auditor", "Auditor", "spawn-audit", { model: "claude-opus-5-5" }),
    facts.turn("auditor", "spawn"),
    facts.message(
      "auditor",
      "audit-note",
      "assistant",
      "Found three kill sites so far; reading the CLI next.",
    ),
    facts.endTurn("auditor", "failed", {
      kind: "provider",
      message: "The model's server closed the stream before the answer finished",
    }),
    facts.subagent("claude", "migrator", "Migrator", "spawn-migrate", {
      model: "claude-sonnet-5-5",
    }),
    facts.turn("migrator", "spawn"),
    facts.subagent("claude", "schema", "Schema checker", "spawn-schema", { parent: "migrator" }),
    facts.turn("schema", "spawn"),
    facts.endTurn("migrator"),
    {
      type: "interaction.opened",
      agent: "schema",
      interaction: "schema-drop",
      blocking: true,
      request: {
        kind: "question",
        questions: [
          {
            id: "drop",
            text: "Drop the old owner table after the copy?",
            multiSelect: false,
            allowOther: false,
            secret: false,
            options: [
              { id: "keep", label: "Keep it for one release (Recommended)" },
              { id: "drop", label: "Drop it now" },
            ],
          },
        ],
      },
    },
    ...launch("spawn-docs", "Document cleanup", "Write the cleanup section of the operator guide."),
    facts.subagent("claude", "writer", "Doc writer", "spawn-docs"),
    facts.turn("writer", "spawn"),
    facts.endTurn("writer", "failed", {
      kind: "quota",
      message: "Usage limit reached for this model",
    }),
    facts.subagent("claude", "linter", "Linter", "spawn-lint"),
    facts.turn("linter", "spawn"),
    facts.endTurn("linter", "interrupted"),
    facts.endTurn("root"),
  ]);

  const big: Fact[] = [facts.rootAgent("codex"), facts.turn("root")];
  for (let index = 0; index < 160; index++)
    big.push(
      facts.subagent("codex", `done-${index}`, `Shard ${index + 1}`, `spawn-${index}`),
      facts.turn(`done-${index}`, "spawn"),
      facts.endTurn(`done-${index}`),
    );
  for (const name of ["Shard 161", "Shard 162"]) {
    const id = name.replace(" ", "-").toLowerCase();
    big.push(facts.subagent("codex", id, name, `spawn-${id}`), facts.turn(id, "spawn"));
  }
  for (let index = 0; index < 45; index++)
    big.push(
      {
        type: "background.started",
        agent: "root",
        task: `job-${index}`,
        kind: "shell",
        title: `bun run shard --index ${index + 1}`,
        stoppable: true,
      },
      ...(index < 3
        ? []
        : [
            {
              type: "background.ended" as const,
              task: `job-${index}`,
              status: "completed" as const,
            },
          ]),
    );
  big.push(facts.endTurn("root"));
  daemon.apply("ios-big-tree", big);
  daemon.updateOffshift("ios-subagents", blockedCard(Date.now() - 600_000));
  daemon.updateOffshift("ios-big-tree", deliveredCard(Date.now() - 60_000));
}
