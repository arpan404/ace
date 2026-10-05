import { availability } from "@ace/accounts/availability";
import type { AccountQuota } from "@ace/protocol/accounts";
import { expect, test } from "vitest";
import { accountView, type AccountView } from "./accounts.ts";
import {
  accountLimit,
  atLimitLine,
  limitChanges,
  limitedGroups,
  nextLimitReset,
  providerHeadroom,
  type LimitReading,
} from "./limits.ts";
import { queueNotice } from "./queue.ts";
import { formatCountdown } from "./time.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const now = new Date("2026-10-01T15:00:00").getTime();

type Window = [id: string, used: number, resetsIn: number | null];

/**
 * An account as `accounts.list` reports it at `now`: its windows (reset times relative to `now`),
 * what its CLI says about sign-in, and any limit error or overflow holding it.
 */
function account(
  id: string,
  windows: Window[],
  patch: Partial<Pick<AccountQuota, "auth" | "blockers">> = {},
): AccountView {
  const provider = id.startsWith("codex")
    ? "codex"
    : id.startsWith("opencode")
      ? "opencode"
      : "claude";
  const quota: AccountQuota = {
    auth: "logged_in",
    observedAt: now,
    windows: Object.fromEntries(
      windows.map(([window, usedPercent, resetsIn]) => [
        window,
        { usedPercent, resetsAt: resetsIn === null ? null : now + resetsIn },
      ]),
    ),
    blockers: {},
    usage: {},
    ...patch,
  };
  return accountView({
    id,
    provider,
    label: id.split("-")[1] ?? id,
    quota,
    availability: availability(quota, now),
  });
}

/** Reads of `accounts.list` in turn, each at its own moment: the changes each one announces. */
function reads(...steps: [accounts: AccountView[], at: number][]) {
  let reading: LimitReading | undefined;
  return steps.map(([accounts, at]) => {
    const read = limitChanges(reading, accounts, at);
    reading = read.reading;
    return read.changes;
  });
}

test("time left until a reset reads in the largest two units, rounded up", () => {
  expect(formatCountdown(20_000)).toBe("1m");
  expect(formatCountdown(0)).toBe("under a minute");
  expect(formatCountdown(12 * minute)).toBe("12m");
  expect(formatCountdown(87 * minute)).toBe("1h 27m");
  expect(formatCountdown(2 * hour)).toBe("2h");
  expect(formatCountdown(4 * 24 * hour + 3 * hour)).toBe("4d 3h");
});

test("an account is near its limit from 80% of a window, at it when one is full, and unknown until its CLI says it is signed in", () => {
  const level = (windows: Window[], patch?: Partial<Pick<AccountQuota, "auth" | "blockers">>) =>
    accountLimit(account("claude-personal", windows, patch), now).level;
  expect(level([["five_hour", 62, hour]])).toBe("ok");
  expect(level([["five_hour", 80, hour]])).toBe("near");
  expect(level([["five_hour", 100, hour]])).toBe("reached");
  // A provider's limit error holds it too, with no window at all.
  expect(level([], { blockers: { limitError: { usedPercent: 100, resetsAt: now + hour } } })).toBe(
    "reached",
  );
  expect(level([["five_hour", 100, hour]], { auth: "unknown" })).toBe("unknown");
  expect(level([["five_hour", 10, hour]], { auth: "logged_out" })).toBe("unknown");
});

test("a window whose reset has passed no longer holds the account, even before quota is read again", () => {
  const team = account("codex-team", [
    ["five_hour", 100, 87 * minute],
    ["seven_day", 40, 3 * day],
  ]);
  expect(accountLimit(team, now).level).toBe("reached");

  const later = accountLimit(team, now + 88 * minute);
  expect(later.level).toBe("ok");
  // The window that decides is now the weekly one; the spent 5-hour window is over.
  expect(later.window).toMatchObject({ label: "Weekly", usedPercent: 40 });
});

test("a reached account works again at the last reset of what holds it, and no time is promised when one doesn't say", () => {
  const both = account("codex-team", [
    ["five_hour", 100, 87 * minute],
    ["seven_day", 100, 3 * day],
  ]);
  // The 5-hour window frees first, but the weekly one still holds it until it resets.
  expect(accountLimit(both, now)).toMatchObject({ level: "reached", resetsAt: now + 3 * day });

  const unsaid = account("codex-team", [
    ["five_hour", 100, 87 * minute],
    ["seven_day", 100, null],
  ]);
  expect(accountLimit(unsaid, now)).toMatchObject({ level: "reached", resetsAt: undefined });

  const limitError = account("codex-team", [["five_hour", 100, 87 * minute]], {
    blockers: { limitError: { usedPercent: 100, resetsAt: null } },
  });
  expect(accountLimit(limitError, now).resetsAt).toBeUndefined();

  const overflow = account("codex-team", [["five_hour", 100, 87 * minute]], {
    blockers: { overflow: true },
  });
  expect(accountLimit(overflow, now).resetsAt).toBeUndefined();
});

/** Claude Code · Personal with one 5-hour window. */
const personal = (used: number, resetsIn: number) => [
  account("claude-personal", [["five_hour", used, resetsIn]]),
];

test("the first read is history; later reads announce near, reached and reset once per window period", () => {
  const [first, warned, nearer, full, fresh] = reads(
    [personal(60, 2 * hour), now],
    [personal(91, 2 * hour), now],
    [personal(95, 2 * hour), now],
    [personal(100, 2 * hour), now],
    [personal(3, 7 * hour), now],
  );
  expect(first).toEqual([]);
  expect(warned).toMatchObject([{ kind: "near", window: { label: "5-hour", usedPercent: 91 } }]);
  // The same window creeping further is the same news.
  expect(nearer).toEqual([]);
  expect(full).toMatchObject([{ kind: "reached", resetsAt: now + 2 * hour }]);
  expect(fresh).toMatchObject([{ kind: "reset" }]);

  // A wobble back across the line names the same window period, so a caller can say it once.
  const [, again, , back] = reads(
    [personal(60, 2 * hour), now],
    [personal(91, 2 * hour), now],
    [personal(70, 2 * hour), now],
    [personal(91, 2 * hour), now],
  );
  expect(back?.[0]?.key).toBe(again?.[0]?.key);
  expect(back?.[0]?.key).toBe(warned?.[0]?.key);
});

test("a full window that resets frees the account: the read after it says it can work again", () => {
  const team = [account("codex-team", [["five_hour", 100, 87 * minute]])];
  // The provider sent nothing new; the same quota read after the reset is the evidence.
  const [, reset] = reads([team, now], [team, now + 88 * minute]);
  expect(reset).toMatchObject([{ kind: "reset", account: { id: "codex-team" } }]);
});

test("losing track of an account at its limit is not a recovery; only a known state that has room is", () => {
  const full = [account("codex-team", [["five_hour", 100, 87 * minute]])];
  // Its CLI no longer says it is signed in and reports no windows: nothing is known.
  const lost = [account("codex-team", [], { auth: "unknown" })];
  const out = [account("codex-team", [], { auth: "logged_out" })];
  const fresh = [account("codex-team", [["five_hour", 4, 5 * hour]])];

  const [, unknown, signedOut, back] = reads([full, now], [lost, now], [out, now], [fresh, now]);
  expect(unknown).toEqual([]);
  expect(signedOut).toEqual([]);
  // Once a read says it has room again, that is news, measured against the limit it was at.
  expect(back).toMatchObject([{ kind: "reset" }]);
});

test("headroom names each provider's account with the most room and the next one to free up", () => {
  const rows = providerHeadroom(
    [
      account("claude-personal", [
        ["five_hour", 62, 2 * hour],
        ["seven_day", 41, 4 * day],
      ]),
      account("claude-work", [
        ["five_hour", 23, 3 * hour],
        ["seven_day", 57, 2 * day],
      ]),
      account("codex-personal", [["five_hour", 38, 3 * hour]]),
      // Both windows full: it frees up when the weekly one resets, not the 5-hour one.
      account("codex-team", [
        ["five_hour", 100, 87 * minute],
        ["seven_day", 100, 2 * day],
      ]),
      // Its full window has already reset: it can work.
      account("codex-spare", [["five_hour", 100, -minute]]),
      // Unknown: neither counted nor compared.
      account("codex-new", [["five_hour", 5, hour]], { auth: "unknown" }),
      // Reports nothing to compare.
      account("opencode-default", []),
    ],
    now,
  );
  expect(rows.map((row) => row.providerLabel)).toEqual(["Claude Code", "Codex"]);
  const [claude, codex] = rows;
  // Work's tightest window (Weekly, 57%) still leaves more than Personal's (5-hour, 62%).
  expect(claude).toMatchObject({ accounts: 2, available: 2, best: { left: 43 } });
  expect(claude?.best?.account.id).toBe("claude-work");
  expect(codex).toMatchObject({ accounts: 3, available: 2, nextReset: { at: now + 2 * day } });
  expect(codex?.best?.account.id).toBe("codex-personal");
});

test("limited threads group by account with when it frees up and where automatic recovery would move them", () => {
  const accounts = [
    account("codex-team", [["five_hour", 100, 87 * minute]]),
    account("codex-personal", [["five_hour", 38, 3 * hour]]),
    account("claude-personal", [["five_hour", 100, hour]]),
  ];
  const groups = limitedGroups(
    [
      { id: "a", title: "A", account: "codex-team", until: undefined },
      { id: "b", title: "B", account: "claude-personal", until: undefined },
      { id: "c", title: "C", account: "codex-team", until: now + 30 * minute },
      { id: "d", title: "D", account: undefined, until: undefined },
    ],
    accounts,
    now,
  );
  expect(groups.map((group) => [group.name, group.threads.map((thread) => thread.id)])).toEqual([
    ["Codex · team", ["a", "c"]],
    ["Claude Code · personal", ["b"]],
    ["Account not reported", ["d"]],
  ]);
  // A thread's own reset is earlier than the account's.
  expect(groups[0]).toMatchObject({
    resetsAt: now + 30 * minute,
    target: { id: "codex-personal", name: "Codex · personal" },
  });
  // Claude has no other account with room.
  expect(groups[1]?.target).toBeNull();
  // Until accounts load, nothing is claimed about where they go.
  expect(
    limitedGroups(
      [{ id: "a", title: "A", account: "codex-team", until: undefined }],
      undefined,
      now,
    )[0]?.target,
  ).toBeUndefined();
});

test("a limited thread's notice uses its account's reset and names where Move sends it", () => {
  const notice = queueNotice(
    { state: "limited" },
    { paused: true, reason: "limit", resumeAt: null },
    now,
    "en-US",
    {
      name: "Codex · Team",
      providerLabel: "Codex",
      resetsAt: now + 87 * minute,
      target: { id: "codex-personal", name: "Codex · Personal" },
    },
  );
  expect(notice?.detail).toBe("Codex · Team resets 4:27 PM, in 1h 27m. Queued messages wait.");
  expect(notice?.actions).toEqual([
    { id: "resume_at_reset", label: "Resume at reset" },
    { id: "snooze_until_reset", label: "Snooze until reset" },
    { id: "migrate_now", label: "Move to Codex · Personal", instanceId: "codex-personal" },
    { id: "resume_now", label: "Resume now" },
  ]);
});

test("with no other account of the provider that has room, the notice offers no move", () => {
  const notice = queueNotice({ state: "limited" }, undefined, now, "en-US", {
    name: "Claude Code · Personal",
    providerLabel: "Claude Code",
    resetsAt: undefined,
    target: null,
  });
  expect(notice?.detail).toBe(
    "The provider didn't say when it resets. No other Claude Code account has room. Queued messages wait.",
  );
  expect(notice?.actions.map((action) => action.id)).toEqual(["resume_now"]);
});

test("the near-limit warning says what the daemon's policy will do at the limit", () => {
  expect(atLimitLine(undefined, undefined)).toBe(
    "At the limit it stops until you choose what to do.",
  );
  expect(atLimitLine("migrate_now", "Claude Code · Work")).toBe(
    "At the limit it moves to Claude Code · Work.",
  );
  expect(atLimitLine("migrate_now", undefined)).toBe(
    "At the limit it moves to another account if one is available.",
  );
  expect(atLimitLine("resume_at_reset", undefined)).toContain("resumes when the window resets");
});

test("the next read is due at the soonest reset of a window or limit error near or at its limit", () => {
  const accounts = [
    account("claude-personal", [
      ["five_hour", 40, 30 * minute],
      ["seven_day", 90, 3 * day],
    ]),
    account("codex-team", [["five_hour", 100, 87 * minute]]),
  ];
  // The 5-hour window at 40% resetting sooner changes nothing worth a read.
  expect(nextLimitReset(accounts, now)).toBe(now + 87 * minute);
  // A limit error that lifts sooner is.
  const errored = account("codex-personal", [], {
    blockers: { limitError: { usedPercent: 100, resetsAt: now + 10 * minute } },
  });
  expect(nextLimitReset([...accounts, errored], now)).toBe(now + 10 * minute);
  // Once that time has passed, it is no longer coming.
  expect(nextLimitReset(accounts, now + 88 * minute)).toBe(now + 3 * day);
  expect(nextLimitReset([account("claude-work", [["five_hour", 20, hour]])], now)).toBe(undefined);
});
