import type { Fact } from "@ace/core";
import type { ProviderKind } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, subagent, tool, turn } from "./facts.ts";
import { workbench } from "./workbench.ts";

/** A scenario and how long ago it last moved, so the Home list shows realistic ages. */
export interface AgedScenario {
  scenario: Scenario;
  agoMs: number;
}

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** Ages from the approved design, keyed by workbench thread id. */
const workbenchAges: Record<string, number> = {
  "thread-retry-budget": 2 * minute + 17_000,
  "thread-sheet-rotate": 9 * minute,
  "thread-refund-tax": 14 * minute,
  "thread-dedupe": 0,
  "thread-install-page": 1 * minute,
  "thread-pdf-locale": 26 * minute,
  "thread-fan-out": 6 * minute,
  "thread-bump-codex": 41 * minute,
};

/**
 * The whole Home list from the design: the workbench, three more live threads, and a dozen
 * finished ones old enough to have settled. Play each with the daemon clock set `agoMs` back.
 */
export function homeList(): AgedScenario[] {
  return [
    ...workbench().map((scenario) => ({
      scenario,
      agoMs: workbenchAges[scenario.thread.id] ?? 0,
    })),
    { scenario: resumableStreams(), agoMs: 3 * hour },
    { scenario: worktreeCleanup(), agoMs: 5 * minute },
    { scenario: haptics(), agoMs: 20 * hour },
    ...settledHistory(),
  ];
}

function opening(provider: ProviderKind, ask: string, workspace: string): Fact[] {
  return [
    rootAgent(provider, `/Users/dev/${workspace}`),
    turn("root"),
    message("root", "ask", "user", ask),
  ];
}

function resumableStreams(): Scenario {
  const lanes = [
    ["cursor-store", "Persist the replay cursor"],
    ["relay-resume", "Resume relay sockets"],
    ["mobile-cold", "Mobile cold-start replay"],
    ["merge-gate", "Merge gate checks"],
  ] as const;
  return {
    thread: {
      id: "thread-resumable-streams",
      workspaceId: "ace",
      title: "Resumable relay streams",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          ...opening(
            "claude",
            "Make relay streams resumable end to end: daemon, relay and both clients.",
            "ace",
          ),
          message(
            "root",
            "plan",
            "assistant",
            "Delegated four tasks. Each agent runs in its own worktree; I review and integrate their changes.",
          ),
          ...lanes.flatMap(([key, title]): Fact[] => [
            tool("root", `spawn-${key}`, {
              kind: "agent.spawn",
              title,
              detail: { kind: "agent.spawn", description: title, childAgent: key },
            }),
            subagent("claude", key, key, `spawn-${key}`),
            turn(key, "spawn"),
          ]),
        ],
      },
    ],
  };
}

function worktreeCleanup(): Scenario {
  return {
    thread: {
      id: "thread-worktree-cleanup",
      workspaceId: "ace",
      title: "Worktree cleanup when a thread is deleted",
      provider: "codex",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          ...opening(
            "codex",
            "Deleting a thread leaves its worktree and branch behind. Clean both up, but never a branch with unpushed commits.",
            "ace",
          ),
          message(
            "root",
            "progress",
            "assistant",
            "Tracing which threads own worktrees under ~/.ace-next/worktrees.",
            false,
          ),
        ],
      },
    ],
  };
}

function haptics(): Scenario {
  return {
    thread: {
      id: "thread-haptics",
      workspaceId: "ace-mobile",
      title: "Haptics on approval and send",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        facts: [
          ...opening(
            "claude",
            "Add a light haptic on approve and on send, and respect the system setting.",
            "ace-mobile",
          ),
          message(
            "root",
            "done",
            "assistant",
            "Approve and send now play a light impact; both skip it when system haptics are off.",
          ),
          endTurn("root"),
        ],
      },
    ],
  };
}

const settled: [
  id: string,
  workspace: string,
  title: string,
  provider: ProviderKind,
  agoMs: number,
][] = [
  ["flaky-restart", "ace", "Fix flaky providerManager restart test", "claude", 26 * hour],
  ["status-json", "ace", "Add --json to ace status", "codex", 2 * day],
  ["mobile-tokens", "ace-mobile", "Theme tokens for the mobile app", "claude", 2 * day + hour],
  ["refund-idempotency", "billing-api", "Refund webhook idempotency key", "claude", 3 * day],
  ["rate-limit-docs", "docs-site", "Rate limit section for the API docs", "opencode", 4 * day],
  ["noise-vectors", "relay", "Noise handshake test vectors", "codex", 5 * day],
  ["settings-keys", "ace", "Settings page keyboard navigation", "claude", 6 * day],
  ["snooze-threads", "ace", "Snooze threads until a time", "claude", 8 * day],
  ["push-approvals", "ace-mobile", "Push notifications for approvals", "codex", 9 * day],
  ["vat-rounding", "billing-api", "VAT rounding for EUR invoices", "cursor", 15 * day],
  ["codex-quickstart", "docs-site", "Quickstart for Codex users", "opencode", 16 * day],
  ["relay-metrics", "relay", "Relay metrics endpoint", "claude", 22 * day],
];

/** Finished threads, each a short exchange that ended cleanly. */
function settledHistory(): AgedScenario[] {
  return settled.map(([id, workspaceId, title, provider, agoMs]) => ({
    agoMs,
    scenario: {
      thread: { id: `thread-${id}`, workspaceId, title, provider },
      steps: [
        {
          kind: "facts",
          facts: [
            ...opening(provider, title, workspaceId),
            message("root", "done", "assistant", `Done: ${title.toLowerCase()}. Tests pass.`),
            endTurn("root"),
          ],
        },
      ],
    },
  }));
}
