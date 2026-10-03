import type { Scenario } from "../scenario.ts";
import { message, rootAgent, turn } from "./facts.ts";

/**
 * A Codex thread on `account` that ran into the account's usage limit mid-turn and stopped
 * there: the thread lists as Limited until it is resumed or moved. Label: `limited`.
 */
export function accountLimit(
  id: string,
  title: string,
  account = "codex-team",
  workspaceId = "ace",
): Scenario {
  return {
    thread: { id, workspaceId, title, provider: "codex", live: { account } },
    steps: [
      {
        kind: "facts",
        facts: [rootAgent("codex"), turn("root"), message("root", "ask", "user", title)],
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
