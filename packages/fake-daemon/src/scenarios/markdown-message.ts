import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, turn } from "./facts.ts";

export const markdownMessageId = "thread-markdown-message";

/** What the person sent: markdown they meant, with a code block, a table and a very long URL. */
export const markdownMessageText = [
  "## Checkout bug",
  "",
  "Paying twice charges the card **twice**. Steps:",
  "",
  "1. Open `/checkout` with two items",
  "2. Double-click *Pay*",
  "3. Watch the network tab",
  "",
  "```ts",
  "await charge(order.id, { idempotencyKey: crypto.randomUUID() }); // new key per click",
  "```",
  "",
  "| Click | Requests | Charged |",
  "| --- | --- | --- |",
  "| once | 1 | yes |",
  "| twice | 2 | twice |",
  "",
  "> The receipt email arrives twice too.",
  "",
  `Trace: https://traces.example.com/checkout/${"9f3c2a7b".repeat(36)}`,
].join("\n");

/** A Claude thread whose person wrote their bug report in markdown, and the agent's reply. */
export function markdownMessage(): Scenario {
  return {
    thread: {
      id: markdownMessageId,
      workspaceId: "acme",
      title: "Double charge on Pay",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("claude"),
          turn("root"),
          message("root", "report", "user", markdownMessageText),
          message(
            "root",
            "answer",
            "assistant",
            "The key is made per click, so the second click looks like a new payment. I'll make one key per order and reuse it on retry.",
          ),
          endTurn("root"),
        ],
      },
    ],
  };
}
