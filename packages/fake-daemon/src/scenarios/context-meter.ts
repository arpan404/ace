import type { ProviderKind } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, tool, turn } from "./facts.ts";

/**
 * An idle thread with a known context occupancy: "62% context" and its compact icon in the
 * strip. `provider` decides whether the strip offers native compaction (Claude, Codex, OpenCode
 * and Pi do; Cursor and ACP don't).
 */
export function contextMeter(
  options: {
    provider?: ProviderKind;
    id?: string;
    /** Occupancy and window, 124,000 of 200,000 by default (62%). */
    usedTokens?: number;
    windowTokens?: number;
  } = {},
): Scenario {
  const provider = options.provider ?? "claude";
  return {
    thread: {
      id: options.id ?? "thread-context",
      workspaceId: "billing-api",
      title: "Tighten the checkout context",
      provider,
      access: "full-access",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent(provider),
          turn("root"),
          message("root", "ask", "user", "Find why the checkout test flakes."),
          message("root", "answer", "assistant", "The poller retries on a fixed 50 ms timer."),
          endTurn("root"),
        ],
      },
      {
        kind: "facts",
        facts: [
          {
            type: "context.sample",
            agent: "root",
            usedTokens: options.usedTokens ?? 124_000,
            windowTokens: options.windowTokens ?? 200_000,
          },
        ],
      },
    ],
  };
}

/**
 * A working thread with the same occupancy: an approval waits on the person, so the request
 * strip carries the readout and its compact icon sits disabled with the reason.
 */
export function contextMeterWaiting(
  options: { provider?: ProviderKind; id?: string } = {},
): Scenario {
  const provider = options.provider ?? "claude";
  return {
    thread: {
      id: options.id ?? "thread-context-working",
      workspaceId: "billing-api",
      title: "Wait for the cache clear",
      provider,
      access: "ask",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent(provider),
          turn("root"),
          message("root", "ask", "user", "Clear the cached test results and rerun."),
          message("root", "answer", "assistant", "I need to clear the cache first."),
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
          {
            type: "context.sample",
            agent: "root",
            usedTokens: 124_000,
            windowTokens: 200_000,
          },
        ],
      },
    ],
  };
}
