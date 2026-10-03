import type { Fact } from "@ace/core";
import type { ProviderKind } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { dedupeReconnect } from "./dedupe-reconnect.ts";
import { endTurn, message, output, rootAgent, tool, toolDone, turn } from "./facts.ts";
import { installPageEdits, refundTaxEdits, retryBudgetEdits } from "./workbench-edits.ts";

/**
 * A realistic Home list across five projects, matching the approved design: three threads
 * that need you, two working (one with subagents and a background shell), one waiting on a
 * background task, one failed and one done. Each scenario settles where it stops, so
 * `runUntilBlocked()` leaves every thread in its listed state.
 */
export function workbench(): Scenario[] {
  return [
    retryBudget(),
    sheetRotate(),
    refundTax(),
    dedupeReconnect(),
    installPage(),
    pdfLocale(),
    fanOut(),
    bumpCodex(),
  ];
}

function opening(provider: ProviderKind, ask: string, cwd: string): Fact[] {
  return [rootAgent(provider, cwd), turn("root"), message("root", "ask", "user", ask)];
}

function approval(
  key: string,
  title: string,
  command: string,
  description: string,
  always: string,
): Fact[] {
  return [
    tool("root", `${key}-call`, {
      kind: "shell",
      title,
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
        title,
        description,
        options: [
          { id: "allow", label: "Approve", kind: "allow_once" },
          { id: "always", label: always, kind: "allow_session" },
          { id: "deny", label: "Deny", kind: "deny" },
        ],
      },
    },
  ];
}

function retryBudget(): Scenario {
  return {
    thread: {
      id: "thread-retry-budget",
      workspaceId: "relay",
      title: "Retry budget for app-server restarts",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        agoMs: 8 * 60_000 + 41_000,
        facts: [
          ...opening(
            "claude",
            "The relay restarts app-server forever when it crashes on boot. Give it a retry budget.",
            "/Users/dev/relay",
          ),
        ],
      },
      ...retryBudgetEdits(),
      {
        kind: "facts",
        agoMs: 1 * 60_000 + 26_000,
        facts: [
          message(
            "root",
            "plan",
            "assistant",
            "Restarts now back off from 250 ms to 30 s and stop after 6 attempts in 5 minutes. I squashed the fixups; the branch needs a force push.",
          ),
          ...approval(
            "approve-force-push",
            "Allow a force push to fix/restart-retry?",
            "git push --force-with-lease origin fix/restart-retry",
            "Rewrites 6 commits on a branch that PR #188 tracks.",
            "Always allow git push in this thread",
          ),
        ],
      },
      { kind: "await", interaction: "approve-force-push" },
    ],
  };
}

function sheetRotate(): Scenario {
  return {
    thread: {
      id: "thread-sheet-rotate",
      workspaceId: "ace-mobile",
      title: "Approval sheet loses its state on rotate",
      provider: "codex",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          ...opening(
            "codex",
            "Rotating the phone while the approval sheet is open resets the toggle and the typed reason.",
            "/Users/dev/ace-mobile",
          ),
          message(
            "root",
            "finding",
            "assistant",
            "The sheet is recreated on rotation and its state lives in the component. There are three ways to fix it.",
          ),
          {
            type: "interaction.opened",
            agent: "root",
            interaction: "ask-recovery",
            blocking: true,
            request: {
              kind: "question",
              questions: [
                {
                  id: "recovery",
                  text: "How should the sheet recover after rotate?",
                  multiSelect: false,
                  allowOther: false,
                  options: [
                    {
                      id: "persist",
                      label: "Persist the draft in the view model (Recommended)",
                      description: "keeps text and the toggle",
                    },
                    {
                      id: "lock",
                      label: "Block rotation while the sheet is open",
                      description: "simplest, feels locked",
                    },
                    {
                      id: "reset",
                      label: "Re-open the sheet with a fresh state",
                      description: "loses typed text",
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      { kind: "await", interaction: "ask-recovery" },
    ],
  };
}

function refundTax(): Scenario {
  return {
    thread: {
      id: "thread-refund-tax",
      workspaceId: "billing-api",
      title: "Partial refunds double-count tax",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        agoMs: 11 * 60_000,
        facts: [
          ...opening(
            "claude",
            "A partial refund on a taxed order refunds the tax twice. Fix it and add a regression test.",
            "/Users/dev/billing-api",
          ),
        ],
      },
      ...refundTaxEdits(),
      {
        kind: "facts",
        facts: [
          message(
            "root",
            "plan",
            "assistant",
            "Refund lines recompute tax from the full order. The Japanese invoice fixture needs a font to render the test PDF.",
          ),
          ...approval(
            "approve-font",
            "Install @fontsource/noto-sans-jp?",
            "bun add @fontsource/noto-sans-jp@5.1.0",
            "Downloads from npm and changes package.json and bun.lock.",
            "Always allow bun add in this thread",
          ),
        ],
      },
      { kind: "await", interaction: "approve-font" },
    ],
  };
}

function installPage(): Scenario {
  return {
    thread: {
      id: "thread-install-page",
      workspaceId: "docs-site",
      title: "Rewrite the install page for the daemon",
      provider: "opencode",
    },
    steps: [
      {
        kind: "facts",
        agoMs: 7 * 60_000,
        facts: [
          ...opening(
            "opencode",
            "Rewrite the install page around `ace start` and the service install.",
            "/Users/dev/docs-site",
          ),
        ],
      },
      ...installPageEdits(),
      {
        kind: "facts",
        facts: [
          message(
            "root",
            "draft",
            "assistant",
            "Drafting the page from the daemon's CLI help.",
            false,
          ),
        ],
      },
    ],
  };
}

function pdfLocale(): Scenario {
  return {
    thread: {
      id: "thread-pdf-locale",
      workspaceId: "billing-api",
      title: "Invoice PDF locale fallback",
      provider: "cursor",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          ...opening(
            "cursor",
            "Invoices for unsupported locales render empty. Fall back to en-US.",
            "/Users/dev/billing-api",
          ),
          tool("root", "tests", {
            kind: "shell",
            title: "Run the invoice tests",
            detail: { kind: "shell", command: "bun run test invoice" },
          }),
          output("root", "tests", "✗ renders de-CH with en-US fallback\n✗ keeps currency symbol\n"),
          toolDone("root", "tests", "failed"),
          endTurn("root", "failed", { kind: "provider", message: "2 tests failing on #74" }),
        ],
      },
    ],
  };
}

function fanOut(): Scenario {
  return {
    thread: {
      id: "thread-fan-out",
      workspaceId: "relay",
      title: "Backpressure on broadcast fan-out",
      provider: "opencode",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          ...opening(
            "opencode",
            "Slow subscribers stall every broadcast. Add per-socket backpressure.",
            "/Users/dev/relay",
          ),
          message(
            "root",
            "plan",
            "assistant",
            "Each socket now has a bounded queue and drops to a resync when it overflows. The soak test is running.",
          ),
          tool("root", "soak", {
            kind: "shell",
            title: "Soak test: 500 slow subscribers",
            detail: { kind: "shell", command: "bun run soak --subscribers 500" },
          }),
          {
            type: "background.started",
            agent: "root",
            task: "soak",
            kind: "shell",
            title: "bun run soak --subscribers 500",
            item: "soak",
            stoppable: true,
          },
          endTurn("root"),
        ],
      },
    ],
  };
}

function bumpCodex(): Scenario {
  return {
    thread: {
      id: "thread-bump-codex",
      workspaceId: "ace",
      title: "Bump Codex app-server to 0.48",
      provider: "codex",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          ...opening(
            "codex",
            "Bump the Codex app-server to 0.48 and re-record the fixtures.",
            "/Users/dev/ace",
          ),
          message(
            "root",
            "done",
            "assistant",
            "Bumped to 0.48, re-recorded 14 fixtures and updated the adapter for the renamed turn events. PR #212 is open.",
          ),
          endTurn("root"),
        ],
      },
    ],
  };
}
