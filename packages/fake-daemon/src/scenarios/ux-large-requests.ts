import type { Scenario } from "../scenario.ts";
import { tool } from "./facts.ts";
import { cwd, scenario } from "./ux-facts.ts";

/*
 * Requests too large to send with their thread (ADR 0156, #2099): clients get them summarized
 * and read them whole before they can say yes.
 */

const root = "root";
/** 2,000 lines, each ending in its number: well over the 64 Ki characters a request may be and still go whole. */
const long = (line: string) => Array.from({ length: 2000 }, (_, at) => `${line} (${at + 1})`);

export function largeRequests(): Scenario[] {
  return [
    scenario(
      "large-approval",
      "Approval with a very long description",
      [
        tool(root, "migrate", {
          kind: "shell",
          title: "Run bun run migrate",
          status: "awaiting_approval",
          detail: { kind: "shell", command: "bun run migrate" },
        }),
        {
          type: "interaction.opened",
          agent: root,
          interaction: "large-approval",
          item: "migrate",
          blocking: true,
          request: {
            kind: "approval",
            title: "Run the database migration?",
            description: long(
              "Rewrites the sessions table in place, then rebuilds its indexes.",
            ).join("\n"),
            target: { tool: "shell", command: "bun run migrate", cwd, access: "execute" },
            options: [
              { id: "allow", kind: "allow_once", label: "Allow once" },
              { id: "deny", kind: "deny", label: "Deny" },
            ],
          },
        },
      ],
      { pending: true },
    ),
    scenario(
      "large-plan",
      "Plan too long to send with the thread",
      [
        {
          type: "interaction.opened",
          agent: root,
          interaction: "large-plan",
          blocking: true,
          request: {
            kind: "plan_review",
            title: "Split the importer",
            markdown: ["# Plan", "", ...long("Move one parser into its own module.")].join("\n"),
          },
        },
      ],
      { pending: true },
    ),
  ];
}
