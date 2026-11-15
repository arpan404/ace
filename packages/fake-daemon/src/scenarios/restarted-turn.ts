import type { Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import type { FakeDaemon } from "../daemon.ts";
import { ScenarioPlayer, type Scenario } from "../scenario.ts";
import { message, rootAgent, tool, toolDone } from "./facts.ts";

const minute = 60_000;

const started = (run: string, trigger: "user" | "restart" | "limit_resume"): Fact => ({
  type: "turn.started",
  agent: "root",
  nativeTurnId: run,
  trigger,
});
const ended = (run: string, outcome: "completed" | "interrupted"): Fact => ({
  type: "turn.ended",
  agent: "root",
  nativeTurnId: run,
  outcome,
});
/** ace's notice when a restart cut the turn short and it carries on by itself. */
const restarted = (item: string): Fact => ({
  type: "item.upsert",
  agent: "root",
  item,
  draft: {
    type: "notice",
    level: "warning",
    complete: true,
    code: "restart_interrupted",
    text: "Interrupted by a restart. Continuing.",
    raw: [],
  },
});
/** What ace sends the agent to carry the turn on: hidden behind the row it reads as. */
const continuation = (item: string, kind: "restart" | "limit_resume", text: string): Fact => ({
  type: "item.upsert",
  agent: "root",
  item,
  draft: {
    type: "message",
    role: "user",
    complete: true,
    synthetic: true,
    origin: { kind },
    parts: [{ type: "text", text }],
  },
});
const childNotice = (item: string, child: string, name: string): Fact => ({
  type: "item.upsert",
  agent: "root",
  item,
  draft: {
    type: "message",
    role: "user",
    complete: true,
    synthetic: true,
    origin: { kind: "subagent_result", threadIds: [ThreadId.parse(child)] },
    parts: [{ type: "text", text: `${name} (${child}) finished and is waiting for you.` }],
  },
});
const shell = (item: string, command: string): Fact[] => [
  tool("root", item, { kind: "shell", title: command, detail: { kind: "shell", command } }),
  toolDone("root", item),
];
const restartText =
  "ace restarted while you were working, so your turn was cut short. Check the state of your work, rerun what was cut short instead of assuming it finished, then continue the task.";

/**
 * The owner's 2026-11-15 thread: a long turn ace restarted three times (twice back to back),
 * whose delegated children reported back together, then a usage limit held it until it resumed.
 * One turn throughout: one "Worked for", the restarts and the wait as quiet rows inside it.
 */
export function restartedTurn(id = "thread-restarted-turn", finished = true): Scenario {
  return {
    thread: { id, workspaceId: "ace", title: "Merge the relay steps", provider: "claude" },
    steps: [
      {
        kind: "facts",
        agoMs: 70 * minute,
        facts: [
          rootAgent("claude"),
          started("t1", "user"),
          message("root", "ask", "user", "Merge the relay steps and watch the stall fix"),
          ...shell("prs", "gh pr list --author @me"),
          message("root", "reading", "assistant", "Three PRs are open. Checking their reviews."),
          ...shell("checks", "gh pr checks 2106"),
        ],
      },
      { kind: "facts", agoMs: 62 * minute, facts: [ended("t1", "interrupted")] },
      {
        kind: "facts",
        agoMs: 60 * minute,
        facts: [
          restarted("restart-1"),
          continuation("restart-1-input", "restart", restartText),
          started("t2", "restart"),
          ended("t2", "interrupted"),
        ],
      },
      {
        kind: "facts",
        agoMs: 53 * minute,
        facts: [
          restarted("restart-2"),
          continuation("restart-2-input", "restart", restartText),
          started("t3", "restart"),
          message(
            "root",
            "again",
            "assistant",
            "ace restarted again. Checking which children are still working, the simulator lock, and the open PRs.",
          ),
          tool("root", "notes", {
            kind: "file.edit",
            title: "Edit test-on-arpans-mac.md",
            detail: {
              kind: "file.edit",
              changes: [{ path: "/Users/dev/acme/test-on-arpans-mac.md", kind: "update" }],
            },
          }),
          toolDone("root", "notes"),
          ended("t3", "interrupted"),
        ],
      },
      {
        kind: "facts",
        agoMs: 51 * minute,
        facts: [
          restarted("restart-3"),
          continuation("restart-3-input", "restart", restartText),
          started("t4", "restart"),
          ...shell("merge", "gh pr merge 2113 --squash"),
        ],
      },
      {
        kind: "facts",
        agoMs: 50 * minute,
        facts: [
          childNotice("child-1", "relay-step-2", "Relay-step-2"),
          childNotice("child-2", "relay-step-3", "Relay-step-3"),
          { type: "retry", agent: "root", on: "rate_limit", message: "Usage limit." },
          ended("t4", "completed"),
        ],
      },
      {
        kind: "facts",
        agoMs: 3 * minute,
        facts: [
          { type: "limit.cleared", agent: "root" },
          started("t5", "limit_resume"),
          continuation("resume-input", "limit_resume", "Continue where you left off."),
          ...shell("stall", "bun run bench:stall"),
          ...(finished
            ? [
                message(
                  "root",
                  "answer",
                  "assistant",
                  "#2113 is merged (3f4573feb). Only the first-swipe stall investigation is still running. Waiting on it.",
                ),
                ended("t5", "completed"),
              ]
            : [message("root", "working", "assistant", "Benchmarking the stall fix now.")]),
        ],
      },
    ],
  };
}

/** The finished turn, and a copy still working after its limit resume. */
export function seedRestartedTurn(daemon: FakeDaemon, id = "thread-restarted-turn"): void {
  new ScenarioPlayer(daemon, restartedTurn(id), { agoMs: 0 }).runUntilBlocked();
  new ScenarioPlayer(daemon, restartedTurn(`${id}-live`, false), { agoMs: 0 }).runUntilBlocked();
}
