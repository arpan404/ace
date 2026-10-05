import { availability } from "@ace/accounts/availability";
import { ThreadId } from "@ace/protocol";
import type { AccountQuota } from "@ace/protocol/accounts";
import { expect, test } from "vitest";
import {
  accountThread,
  accountThreadCounts,
  headroom,
  migrationTarget,
  type AccountThreadSource,
} from "./account-threads.ts";
import { accountView, type AccountView } from "./accounts.ts";

function thread(
  id: string,
  state: AccountThreadSource["status"],
  extra: Partial<AccountThreadSource> = {},
): AccountThreadSource {
  return { id: ThreadId.parse(id), status: state, live: { account: "codex-team" }, ...extra };
}

const now = Date.parse("2026-10-01T15:00:00Z");
const hour = 3_600_000;

/** An account as `accounts.list` reports it: what its CLI says about sign-in, and its windows. */
function account(
  id: string,
  windows: [used: number, resetsAt: number | null][] = [],
  options: { provider?: "codex" | "claude"; auth?: AccountQuota["auth"] } = {},
): AccountView {
  const quota: AccountQuota = {
    auth: options.auth ?? "logged_in",
    observedAt: now,
    windows: Object.fromEntries(
      windows.map(([usedPercent, resetsAt], index) => [`w${index}`, { usedPercent, resetsAt }]),
    ),
    blockers: {},
    usage: {},
  };
  return accountView({
    id,
    provider: options.provider ?? "codex",
    label: id,
    quota,
    availability: availability(quota, now),
  });
}

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

test("threads move where automatic recovery would take them: the first other available account of the provider", () => {
  const accounts = [
    account("codex-team", [[100, now + hour]]),
    // Near its limit, so recovery passes it over, though it is listed first.
    account("codex-busy", [[90, now + hour]]),
    account("codex-spare", [[70, now + hour]]),
    // More room, but listed after the one recovery picks.
    account("codex-personal", [[38, now + hour]]),
    account("claude-personal", [[5, now + hour]], { provider: "claude" }),
  ];

  expect(migrationTarget(accounts, "codex-team", now)?.id).toBe("codex-spare");
});

test("there is nowhere to move when every other account is at its limit, signed out or unknown", () => {
  const accounts = [
    account("codex-team", [[100, now + hour]]),
    account("codex-other", [[100, null]]),
    account("codex-old", [], { auth: "logged_out" }),
    // Its CLI hasn't said it is signed in: nothing is known about its room.
    account("codex-new", [], { auth: "unknown" }),
  ];

  expect(migrationTarget(accounts, "codex-team", now)).toBeUndefined();
});

test("an account whose full window has reset can take the threads again", () => {
  const other = account("codex-other", [[100, now - 1]]);

  expect(
    migrationTarget([account("codex-team", [[100, now + hour]]), other], "codex-team", now),
  ).toBe(other);
  // Its only window is over, so nothing measures how much room it has.
  expect(headroom(other, now)).toBeUndefined();
});
