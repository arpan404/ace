import type { Fact } from "@ace/core";
import type { Scenario } from "../scenario.ts";
import { message, rootAgent, tool, toolDone, turn } from "./facts.ts";

/**
 * As a real turn the limit cuts short: the agent said where it got to, then kept working, and
 * the limit hit between steps.
 */
const workBeforeLimit: Fact[] = [
  tool("root", "survey", {
    kind: "shell",
    title: "rg --files src | head -40",
    detail: { kind: "shell", command: "rg --files src | head -40" },
  }),
  toolDone("root", "survey"),
  message(
    "root",
    "progress",
    "assistant",
    "I've mapped the code this touches and have a plan. Next I'll check the entry point and run the affected tests before changing anything.",
  ),
  tool("root", "read", {
    kind: "file.read",
    title: "Read src/index.ts",
    detail: { kind: "file.read", path: "src/index.ts" },
  }),
  toolDone("root", "read"),
  tool("root", "test", {
    kind: "shell",
    title: "bun run test src",
    detail: { kind: "shell", command: "bun run test src" },
  }),
  toolDone("root", "test"),
];

/**
 * A Codex thread on `account` that ran into the account's usage limit mid-turn and stopped
 * there: the thread lists as Limited until it is resumed or moved. Label: `limited`.
 */
export function accountLimit(
  id: string,
  title: string,
  account = "codex-team",
  workspaceId = "ace",
  /** False: the limit hit before the agent did or said anything. */
  worked = true,
): Scenario {
  return {
    thread: { id, workspaceId, title, provider: "codex", live: { account } },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("codex"),
          turn("root"),
          message("root", "ask", "user", title),
          ...(worked ? workBeforeLimit : []),
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

/** The design's exhausted Codex Team account: three threads stopped at its 5-hour limit. */
export function teamAtLimit(): Scenario[] {
  return [
    accountLimit("thread-limit-flags", "Remove the legacy feature-flag reader"),
    accountLimit("thread-limit-search", "Rank workspace search by recent edits"),
    accountLimit("thread-limit-ci", "Split the CI matrix by package"),
  ];
}
