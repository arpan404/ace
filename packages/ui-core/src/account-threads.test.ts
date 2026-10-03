import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  accountThread,
  accountThreadCounts,
  migrationTarget,
  type AccountThreadSource,
} from "./account-threads.ts";
import type { AccountView } from "./accounts.ts";

function thread(
  id: string,
  state: AccountThreadSource["status"],
  extra: Partial<AccountThreadSource> = {},
): AccountThreadSource {
  return { id: ThreadId.parse(id), status: state, live: { account: "codex-team" }, ...extra };
}

function account(id: string, extra: Partial<AccountView> = {}): AccountView {
  return {
    id,
    provider: "codex",
    providerLabel: "Codex",
    version: "0.48",
    label: id,
    availability: "available",
    signedIn: true,
    windows: [],
    ...extra,
  };
}

const used = (usedPercent: number) => [
  { id: "five_hour", label: "5-hour", usedPercent, resetsAt: null },
];

test("limited threads and threads still in flight count against their account; finished ones don't", () => {
  const counts = accountThreadCounts(
    [
      thread("a", { state: "limited", until: 5 }),
      thread("b", { state: "working", agents: 1 }),
      thread("c", { state: "needs_you", interactions: 1 }),
      thread("d", { state: "done" }),
      thread("e", { state: "failed" }),
      thread("f", { state: "limited" }, { archivedAt: 3 }),
      thread("g", { state: "working", agents: 2 }, { live: {}, execution: undefined }),
      thread(
        "h",
        { state: "waiting", on: "queue" },
        {
          live: undefined,
          execution: { provider: "codex", instanceId: "codex-personal", options: {} },
        },
      ),
    ].flatMap((entry) => accountThread(entry) ?? []),
  );

  expect(counts.get("codex-team")).toEqual({ running: 2, limited: 1, limitedIds: ["a"] });
  expect(counts.get("codex-personal")).toEqual({ running: 1, limited: 0, limitedIds: [] });
  expect(counts.size).toBe(2);
});

test("an exhausted account's threads move to the same provider's account with most headroom", () => {
  const accounts = [
    account("codex-team", { availability: "exhausted", windows: used(100) }),
    account("codex-personal", { windows: used(38) }),
    account("codex-spare", { windows: used(70) }),
    account("claude-personal", { provider: "claude", windows: used(5) }),
  ];

  expect(migrationTarget(accounts, "codex-team")?.id).toBe("codex-personal");
});

test("there is nowhere to move when every other account is exhausted or signed out", () => {
  const accounts = [
    account("codex-team", { availability: "exhausted", windows: used(100) }),
    account("codex-other", { availability: "exhausted", windows: used(100) }),
    account("codex-old", { signedIn: false, availability: "logged_out" }),
  ];

  expect(migrationTarget(accounts, "codex-team")).toBeUndefined();
});
