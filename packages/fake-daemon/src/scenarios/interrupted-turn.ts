import type { Fact } from "@ace/core";
import type { FakeDaemon } from "../daemon.ts";
import { ScenarioPlayer } from "../scenario.ts";
import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, tool, toolDone, turn } from "./facts.ts";

/** A background command the turn started, as an adapter reports one. */
function background(item: string, command: string): Fact[] {
  return [
    tool("root", item, { kind: "shell", title: command, detail: { kind: "shell", command } }),
    {
      type: "background.started",
      agent: "root",
      task: item,
      kind: "shell",
      title: command,
      item,
      stoppable: true,
    },
  ];
}
function ended(item: string): Fact[] {
  return [{ type: "background.ended", task: item, status: "completed" }, toolDone("root", item)];
}
/** The daemon's report of a Stop OpenCode refused because nothing was running. */
function refusedStop(item: string): Fact {
  return {
    type: "item.upsert",
    agent: "root",
    item,
    draft: {
      type: "notice",
      level: "error",
      complete: true,
      code: "delivery_failed",
      title: "Couldn't stop the agent",
      text: "OpenCode had nothing running to stop",
      detail: "OpenCode had nothing running to stop",
      raw: [],
    },
  };
}

/**
 * The owner's 2026-10-13 OpenCode thread: three background commands started back to back (two
 * ended at once), an answer, then a second turn the person tried to stop three times before a
 * restart interrupted it. The queue is held for the person's Resume.
 */
export function interruptedTurn(id = "thread-interrupted-turn"): Scenario {
  return {
    thread: { id, workspaceId: "ace", title: "Align portfolio and resume", provider: "opencode" },
    steps: [
      {
        kind: "facts",
        label: "background",
        agoMs: 2000,
        facts: [
          rootAgent("opencode"),
          turn("root"),
          message(
            "root",
            "ask",
            "user",
            "Tell me how we can make our projects align for my resume",
          ),
          ...background("bg-build", "bun run build"),
          ...background("bg-lint", "bun run lint"),
          ...background("bg-types", "bun run typecheck"),
          ...ended("bg-lint"),
          ...ended("bg-types"),
        ],
      },
      { kind: "facts", label: "background-done", agoMs: 600, facts: ended("bg-build") },
      {
        kind: "facts",
        label: "interrupted",
        facts: [
          message(
            "root",
            "answer",
            "assistant",
            "Your portfolio and resume already match on the top three projects. Fix the metric drift first: pick one calculation for each number and use it in both places.",
          ),
          endTurn("root"),
          message("root", "ask-2", "user", "can you use computer?"),
          turn("root"),
          refusedStop("stop-1"),
          refusedStop("stop-2"),
          refusedStop("stop-3"),
          endTurn("root", "interrupted"),
          {
            type: "item.upsert",
            agent: "root",
            item: "interrupted",
            draft: {
              type: "notice",
              level: "warning",
              complete: true,
              code: "restart_interrupted",
              text: "Interrupted by a restart",
              raw: [],
            },
          },
        ],
      },
    ],
  };
}

/**
 * Plays the interrupted thread and holds its queue as the restarted daemon does, beside a copy
 * still in its first turn, while one of its three background commands runs.
 */
export function seedInterruptedTurn(daemon: FakeDaemon, id = "thread-interrupted-turn"): void {
  new ScenarioPlayer(daemon, interruptedTurn(id), { agoMs: 0 }).runUntilBlocked();
  daemon.holdQueue(id, "restart");
  new ScenarioPlayer(daemon, interruptedTurn(`${id}-live`), { agoMs: 0 }).runThrough("background");
}
