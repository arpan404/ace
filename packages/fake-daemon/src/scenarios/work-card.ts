import type { Scenario } from "../scenario.ts";
import { rootAgent, subagent, turn, endTurn, tool, toolDone, message } from "./facts.ts";

export type WorkCardState = "changes" | "worktree" | "merged" | "remote" | "many-agents" | "failed";

/** Synthetic checkout states with nested agents and shells that outlive their turns. */
export function workCardScenario(state: WorkCardState = "changes"): Scenario {
  const repository = { forge: "github" as const, host: "github.com", owner: "acme", name: "relay" };
  const worktree = state === "worktree";
  const changed = state === "changes" || state === "many-agents" || state === "failed";
  const linked = state === "changes" || state === "merged" || state === "many-agents";
  const facts = [
    rootAgent("codex"),
    turn("root"),
    message("root", "request", "user", "Give the restart loop a retry budget."),
    message(
      "root",
      "answer",
      "assistant",
      "Restarts now back off and stop after six attempts. The tests cover recovery after a clean restart.",
    ),
    endTurn("root"),
  ];
  if (changed) {
    const count = state === "many-agents" ? 12 : 3;
    for (let i = 0; i < count; i++) {
      const id = `worker-${i}`;
      const title =
        ["Write retry tests", "Check supervisor logs", "Read restart history"][i % 3] ??
        "Review retry budget";
      facts.push(
        tool(i === 1 ? "worker-0" : "root", `spawn-${i}`, {
          kind: "agent.spawn",
          title,
          detail: { kind: "agent.spawn", description: title, childAgent: id },
        }),
        subagent(
          "codex",
          id,
          count > 3 ? `${title} ${i + 1}` : title,
          `spawn-${i}`,
          i === 1 ? { parent: "worker-0" } : {},
        ),
        turn(id, "spawn"),
        toolDone(i === 1 ? "worker-0" : "root", `spawn-${i}`),
      );
      if (i >= 2) facts.push(endTurn(id));
      if (state === "failed" && i === 1)
        facts.push(
          endTurn(id, "failed", {
            code: "fixture_failure",
            message: "The test command failed. Check its output.",
            kind: "provider",
          }),
        );
    }
    facts.push(
      tool("root", "watch", {
        kind: "shell",
        title: "Watch the restart tests",
        detail: { kind: "shell", command: "bun run dev" },
      }),
      {
        type: "background.started",
        agent: "root",
        task: "watch",
        kind: "shell",
        title: "Watch the restart tests",
        item: "watch",
        ambient: true,
        stoppable: true,
      },
      tool("root", "ended-shell", {
        kind: "shell",
        title: "Read history",
        detail: { kind: "shell", command: "git log -5" },
      }),
      toolDone("root", "ended-shell"),
    );
  }
  return {
    thread: {
      id: `work-card-${state}`,
      workspaceId: "relay",
      title: "Retry budget for app-server restarts",
      provider: "codex",
      details: {
        workspace: { id: "relay", name: "relay", path: "/Users/dev/relay" },
        worktree: worktree ? "/tmp/ace-fixture/worktree/relay" : "/Users/dev/relay",
        mode: worktree ? "worktree" : "local",
        branch: "fix/restart-retry",
        baseBranch: "main",
        ahead: changed ? 1 : 0,
        behind: 0,
        head: "a".repeat(40),
        repository,
        machine: state === "remote" ? { host: "build-server", name: "Build server" } : undefined,
        diff: { files: changed ? 2 : 0, additions: changed ? 34 : 0, deletions: changed ? 1 : 0 },
        ...(linked
          ? {
              linkedPrs: [
                {
                  repo: repository,
                  number: 188,
                  updatedAt: 1000,
                  title: "Retry budget",
                  state: state === "merged" ? ("merged" as const) : ("open" as const),
                  url: "https://github.com/acme/relay/pull/188",
                },
              ],
            }
          : {}),
      },
    },
    steps: [{ kind: "facts", facts }],
  };
}
