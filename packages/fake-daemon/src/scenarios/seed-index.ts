import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, tool, toolDone, turn } from "./facts.ts";

/**
 * A docs-site thread whose approval offers an "always allow" scope, for Activity's
 * "Always allow bun run in docs-site" checkbox. Steps: `working` (the agent is reading the
 * index config), `approval-requested` (blocked on the seed command), then it finishes once
 * the person answers.
 */
export function seedIndex(): Scenario {
  return {
    thread: {
      id: "thread-seed-index",
      workspaceId: "docs-site",
      title: "Seed the docs search index",
      provider: "claude",
      // This scenario explicitly demonstrates a permanent native grant.
      permissionMode: "full-access",
    },
    steps: [
      {
        kind: "facts",
        label: "working",
        facts: [
          rootAgent("claude", "/Users/dev/docs-site"),
          turn("root"),
          message(
            "root",
            "ask",
            "user",
            "Search returns nothing for pages added this week. Rebuild the index from the content folder.",
          ),
          message(
            "root",
            "finding",
            "assistant",
            "The index was last built before the content move to src/content/docs, so 41 pages are missing. Reseeding fixes it.",
          ),
        ],
      },
      {
        kind: "facts",
        label: "approval-requested",
        facts: [
          tool("root", "seed-call", {
            kind: "shell",
            title: "Reseed the search index",
            status: "awaiting_approval",
            detail: { kind: "shell", command: "bun run search:seed --from src/content/docs" },
          }),
          {
            type: "interaction.opened",
            agent: "root",
            interaction: "approve-seed",
            blocking: true,
            item: "seed-call",
            request: {
              kind: "approval",
              title: "Reseed the docs search index?",
              description: "Drops and rebuilds the local Pagefind index from 212 pages.",
              options: [
                { id: "allow", label: "Allow once", kind: "allow_once" },
                { id: "always", label: "Always allow bun run in docs-site", kind: "allow_always" },
                { id: "deny", label: "Deny", kind: "deny" },
              ],
            },
          },
        ],
      },
      {
        kind: "await",
        interaction: "approve-seed",
        next: (resolution) =>
          resolution?.kind === "approval" && resolution.optionId !== "deny"
            ? [
                {
                  kind: "facts",
                  delayMs: 600,
                  facts: [
                    toolDone("root", "seed-call"),
                    message(
                      "root",
                      "done",
                      "assistant",
                      "Reseeded 212 pages. Searching for “service install” now finds the new page.",
                    ),
                    endTurn("root"),
                  ],
                },
              ]
            : [
                {
                  kind: "facts",
                  facts: [
                    toolDone("root", "seed-call", "declined"),
                    message(
                      "root",
                      "denied",
                      "assistant",
                      "Left the index as it is. Tell me when it's safe to rebuild.",
                    ),
                    endTurn("root"),
                  ],
                },
              ],
      },
    ],
  };
}
