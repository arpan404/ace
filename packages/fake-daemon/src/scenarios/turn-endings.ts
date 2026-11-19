import type { FakeDaemon } from "../daemon.ts";
import { ScenarioPlayer } from "../scenario.ts";
import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, tool, toolDone, turn } from "./facts.ts";

/**
 * A Codex turn that read a file, said what it found, ran one more search, then hit its account's
 * usage limit. It reads as a complete turn; the limit is said only in the composer's strip.
 */
export function limitPausedTurn(id = "thread-limit-paused"): Scenario {
  return {
    thread: {
      id,
      workspaceId: "ace",
      title: "Remove the legacy feature-flag reader",
      provider: "codex",
      live: { account: "codex-team" },
    },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("codex"),
          turn("root"),
          message("root", "ask", "user", "Remove the legacy feature-flag reader"),
          tool("root", "read", {
            kind: "file.read",
            title: "Read src/flags/reader.ts",
            detail: { kind: "file.read", path: "src/flags/reader.ts" },
          }),
          toolDone("root", "read"),
          message("root", "found", "assistant", "Three modules still import the legacy reader."),
          tool("root", "grep", {
            kind: "shell",
            title: "rg legacyFlags",
            detail: { kind: "shell", command: "rg legacyFlags" },
          }),
          toolDone("root", "grep"),
        ],
      },
      {
        kind: "facts",
        label: "limited",
        facts: [
          {
            type: "retry",
            agent: "root",
            on: "rate_limit",
            message: "You've hit your usage limit for this window.",
          },
        ],
      },
    ],
  };
}

/** A Claude turn the person stopped mid-build: done, already read, nothing to continue. */
export function stoppedByYou(id = "thread-stopped-by-you"): Scenario {
  return {
    thread: { id, workspaceId: "ace", title: "Long build", provider: "claude" },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("claude"),
          turn("root"),
          message("root", "ask", "user", "Build the release bundle."),
          tool("root", "build", {
            kind: "shell",
            title: "bun run build",
            detail: { kind: "shell", command: "bun run build" },
          }),
          message("root", "partial", "assistant", "Building the web bundle first", false),
          endTurn("root", "interrupted"),
        ],
      },
    ],
  };
}

/** `?fakeWorld=turn-endings`: a turn a usage limit paused, and a turn the person stopped. */
export function seedTurnEndings(daemon: FakeDaemon): void {
  new ScenarioPlayer(daemon, limitPausedTurn(), { agoMs: 0 }).runUntilBlocked();
  const stopped = stoppedByYou();
  new ScenarioPlayer(daemon, stopped, { agoMs: 0 }).runUntilBlocked();
  daemon.holdQueue(stopped.thread.id, "stopped");
}
