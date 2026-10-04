import type { Fact } from "@ace/core";
import type { Scenario, Step } from "../scenario.ts";
import { checkout } from "./checkouts.ts";
import { endTurn, message, rootAgent, tool, toolDone, turn } from "./facts.ts";

const cwd = "/Users/dev/relay";

/** A shell command that needs approval, with the exact target ace's risk policy reviews. */
function ask(key: string, command: string, description: string): Fact[] {
  return [
    tool("root", `${key}-call`, {
      kind: "shell",
      title: command,
      status: "awaiting_approval",
      detail: { kind: "shell", command },
    }),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: key,
      blocking: true,
      item: `${key}-call`,
      request: {
        kind: "approval",
        title: `Run ${command}?`,
        description,
        target: { tool: "shell", command, cwd, access: "execute" },
        options: [
          { id: "allow", label: "Allow once", kind: "allow_once" },
          { id: "deny", label: "Deny", kind: "deny" },
        ],
      },
    },
  ];
}

/** Waits for the answer (ace's or a person's) and closes the call the way it went. */
function answered(key: string, after: Step[] = []): Step {
  return {
    kind: "await",
    interaction: key,
    next: (resolution) => [
      {
        kind: "facts",
        delayMs: 300,
        facts: [
          toolDone(
            "root",
            `${key}-call`,
            resolution?.kind === "approval" && resolution.optionId === "allow"
              ? "succeeded"
              : "declined",
          ),
        ],
      },
      ...after,
    ],
  };
}

/**
 * A Codex thread under auto-review whose commands meet ace's risk policy: `pwd` is approved on
 * its own, `rm -rf dist` is denied, and `npm publish --dry-run` is sent to a person, so the
 * transcript shows all three decisions and Activity the one still waiting. Labels: `approved`,
 * `denied`, `escalated`.
 */
export function permissionAudit(id = "thread-release-audit"): Scenario {
  return {
    thread: {
      id,
      workspaceId: "relay",
      title: "Dry-run the 0.9 release",
      provider: "codex",
      permissionMode: "auto-review",
      details: checkout({
        workspaceId: "relay",
        branch: "release/0.9",
        path: cwd,
        head: "c41e07",
        mode: "local",
      }),
    },
    steps: [
      {
        kind: "facts",
        facts: [
          rootAgent("codex", cwd),
          turn("root"),
          message(
            "root",
            "ask",
            "user",
            "Clean out the old build and dry-run publishing 0.9 so we can see what would ship.",
          ),
        ],
      },
      {
        kind: "facts",
        delayMs: 600,
        label: "approved",
        facts: ask("check-cwd", "pwd", "Confirms the release runs from the relay checkout."),
      },
      answered("check-cwd"),
      {
        kind: "facts",
        delayMs: 700,
        label: "denied",
        facts: ask("clean-dist", "rm -rf dist", "Removes the previous build before packing."),
      },
      answered("clean-dist", [
        {
          kind: "facts",
          delayMs: 500,
          facts: [
            message(
              "root",
              "denied-note",
              "assistant",
              "ace declined deleting dist, so I'll pack into a fresh directory instead.",
            ),
          ],
        },
      ]),
      {
        kind: "facts",
        delayMs: 700,
        label: "escalated",
        facts: ask(
          "dry-run",
          "npm publish --dry-run",
          "Lists every file the 0.9 package would publish, without uploading it.",
        ),
      },
      answered("dry-run", [
        {
          kind: "facts",
          delayMs: 800,
          facts: [
            message(
              "root",
              "done",
              "assistant",
              "The dry run packs 41 files (212 kB). Nothing outside dist/ and README.md would ship.",
            ),
            endTurn("root"),
          ],
        },
      ]),
    ],
  };
}
