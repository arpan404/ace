import type { FakeDaemon } from "../daemon.ts";
import { ScenarioPlayer, type Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, tool, turn } from "./facts.ts";

/**
 * A finished turn that left a dev server running (ADR 0109): Codex never wakes the agent when
 * the terminal ends, so the thread is done and the server is listed as still running.
 */
export function leftRunning(id = "thread-left-running"): Scenario {
  const command = "bun run dev";
  return {
    thread: { id, workspaceId: "ace", title: "Start the docs site", provider: "codex" },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("codex"),
          turn("root"),
          message("root", "ask", "user", "Start the docs site so I can look at it."),
          tool("root", "dev", {
            kind: "shell",
            title: command,
            detail: { kind: "shell", command },
          }),
          {
            type: "background.started",
            agent: "root",
            task: "dev",
            kind: "shell",
            title: command,
            item: "dev",
            stoppable: true,
            wakesAgent: false,
          },
          {
            type: "background.listening",
            task: "dev",
            ports: [5173],
          },
          message(
            "root",
            "answer",
            "assistant",
            "The docs site is running at http://localhost:5173. Stop it from the composer when you're done.",
          ),
          endTurn("root"),
        ],
      },
    ],
  };
}

export function seedLeftRunning(daemon: FakeDaemon, id = "thread-left-running"): void {
  new ScenarioPlayer(daemon, leftRunning(id), { agoMs: 0 }).runUntilBlocked();
}
