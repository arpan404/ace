import type { Scenario } from "../scenario.ts";
import {
  endTurn,
  finish,
  message,
  output,
  rootAgent,
  stream,
  subagent,
  tool,
  toolDone,
  turn,
} from "./facts.ts";
import { checkout } from "./checkouts.ts";

/**
 * A Claude thread with a subagent, a background test watcher and an approval.
 * Labels: `explorer-spawned`, `watcher-started`, `approval-requested`, `done`.
 */
export function flakyCheckout(id = "thread-checkout"): Scenario {
  return {
    thread: {
      id,
      workspaceId: "billing-api",
      title: "Fix flaky checkout test",
      provider: "claude",
      // Manual approval/reconnect scenario; auto-review has its own audit scenarios.
      permissionMode: "ask",
      details: checkout({
        workspaceId: "billing-api",
        branch: "fix/checkout-flake",
        path: "/Users/dev/.ace/worktrees/billing-api-checkout-flake",
        head: "8a41d2",
        diff: { files: 3, additions: 27, deletions: 11 },
      }),
    },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("claude"),
          turn("root"),
          message(
            "root",
            "ask",
            "user",
            "checkout.spec.ts fails about one run in five. Find out why and fix it.",
          ),
        ],
      },
      {
        kind: "facts",
        delayMs: 700,
        facts: [message("root", "plan", "assistant", "I'll look for timing assumptions", false)],
      },
      {
        kind: "facts",
        delayMs: 300,
        facts: [stream("root", "plan", " in the checkout flow first.")],
      },
      { kind: "facts", delayMs: 200, facts: [finish("root", "plan")] },
      {
        kind: "facts",
        delayMs: 600,
        label: "explorer-spawned",
        facts: [
          tool("root", "spawn-explorer", {
            kind: "agent.spawn",
            title: "Explore checkout timing",
            detail: {
              kind: "agent.spawn",
              description: "Find timers and retries in checkout",
              childAgent: "explorer",
            },
          }),
          subagent("claude", "explorer", "explorer", "spawn-explorer"),
          turn("explorer", "spawn"),
        ],
      },
      {
        kind: "facts",
        delayMs: 900,
        facts: [
          tool("explorer", "grep", {
            kind: "search",
            title: "Search setTimeout in src/checkout",
            detail: { kind: "search", query: "setTimeout", path: "src/checkout" },
          }),
        ],
      },
      {
        kind: "facts",
        delayMs: 700,
        facts: [
          toolDone("explorer", "grep"),
          message(
            "explorer",
            "finding",
            "assistant",
            "The payment poller retries on a fixed 50 ms timer; the test asserts after 40 ms.",
          ),
          endTurn("explorer"),
          toolDone("root", "spawn-explorer"),
        ],
      },
      {
        kind: "facts",
        delayMs: 800,
        label: "watcher-started",
        facts: [
          tool("root", "watch", {
            kind: "shell",
            title: "Run checkout tests in watch mode",
            detail: { kind: "shell", command: "bun run test --watch checkout" },
          }),
          {
            type: "background.started",
            agent: "root",
            task: "watcher",
            kind: "shell",
            title: "checkout tests (watch)",
            item: "watch",
            stoppable: true,
          },
          output("root", "watch", "✓ checkout.spec.ts (12 tests)\n"),
        ],
      },
      {
        kind: "facts",
        delayMs: 900,
        label: "approval-requested",
        facts: [
          tool("root", "clear-cache", {
            kind: "shell",
            title: "Clear the test cache",
            status: "awaiting_approval",
            detail: { kind: "shell", command: "rm -rf node_modules/.cache/vitest" },
          }),
          {
            type: "interaction.opened",
            agent: "root",
            interaction: "approve-clear-cache",
            blocking: true,
            item: "clear-cache",
            request: {
              kind: "approval",
              title: "Run rm -rf node_modules/.cache/vitest?",
              description: "Clears cached test results so the watcher reruns every spec.",
              options: [
                { id: "allow", label: "Allow once", kind: "allow_once" },
                { id: "deny", label: "Deny", kind: "deny" },
              ],
            },
          },
        ],
      },
      {
        kind: "await",
        interaction: "approve-clear-cache",
        next: (resolution) =>
          resolution?.kind === "approval" && resolution.optionId === "allow"
            ? [
                { kind: "facts", delayMs: 500, facts: [toolDone("root", "clear-cache")] },
                {
                  kind: "facts",
                  delayMs: 900,
                  facts: [
                    output(
                      "root",
                      "watch",
                      "✓ checkout.spec.ts (12 tests) — 25 consecutive passes\n",
                    ),
                    message(
                      "root",
                      "fix",
                      "assistant",
                      "The poller now awaits the payment promise instead of a fixed timer. 25 consecutive passes.",
                    ),
                  ],
                },
                ...settle(),
              ]
            : [
                {
                  kind: "facts",
                  delayMs: 400,
                  facts: [toolDone("root", "clear-cache", "declined")],
                },
                ...settle(),
              ],
      },
    ],
  };
}
function settle(): Scenario["steps"] {
  return [
    {
      kind: "facts",
      delayMs: 700,
      facts: [
        { type: "background.ended", task: "watcher", status: "completed" },
        toolDone("root", "watch"),
      ],
    },
    { kind: "facts", delayMs: 300, label: "done", facts: [endTurn("root")] },
  ];
}
