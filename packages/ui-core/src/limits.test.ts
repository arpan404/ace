import { expect, test } from "vitest";
import type { AccountView } from "./accounts.ts";
import {
  accountLimit,
  atLimitLine,
  limitChanges,
  limitedGroups,
  nextLimitReset,
  providerHeadroom,
} from "./limits.ts";
import { queueNotice } from "./queue.ts";
import { formatCountdown } from "./time.ts";

const minute = 60_000;
const hour = 60 * minute;
const now = new Date("2026-10-01T15:00:00").getTime();

function account(
  id: string,
  windows: [id: string, label: string, used: number, resetsIn: number | null][],
  patch: Partial<AccountView> = {},
): AccountView {
  const provider = id.startsWith("codex") ? "codex" : "claude";
  return {
    id,
    provider,
    providerLabel: provider === "codex" ? "Codex" : "Claude Code",
    version: undefined,
    label: id.split("-")[1] ?? id,
    availability: windows.some(([, , used]) => used >= 100) ? "exhausted" : "available",
    signedIn: true,
    windows: windows.map(([window, label, usedPercent, resetsIn]) => ({
      id: window,
      label,
      usedPercent,
      resetsAt: resetsIn === null ? null : now + resetsIn,
    })),
    ...patch,
  };
}

test("time left until a reset reads in the largest two units, rounded up", () => {
  expect(formatCountdown(20_000)).toBe("1m");
  expect(formatCountdown(0)).toBe("under a minute");
  expect(formatCountdown(12 * minute)).toBe("12m");
  expect(formatCountdown(87 * minute)).toBe("1h 27m");
  expect(formatCountdown(2 * hour)).toBe("2h");
  expect(formatCountdown(4 * 24 * hour + 3 * hour)).toBe("4d 3h");
});

test("an account is near its limit past 85% or when the daemon says so, and at it when full", () => {
  expect(accountLimit(account("claude-personal", [["five_hour", "5-hour", 62, hour]])).level).toBe(
    "ok",
  );
  expect(accountLimit(account("claude-personal", [["five_hour", "5-hour", 86, hour]])).level).toBe(
    "near",
  );
  expect(
    accountLimit(
      account("claude-personal", [["five_hour", "5-hour", 40, hour]], {
        availability: "near_limit",
      }),
    ).level,
  ).toBe("near");
  const full = accountLimit(
    account("codex-team", [
      ["five_hour", "5-hour", 100, 87 * minute],
      ["seven_day", "Weekly", 100, 3 * 24 * hour],
    ]),
  );
  // It can work again once the first full window resets.
  expect(full).toMatchObject({ level: "reached", resetsAt: now + 87 * minute });
});

test("the first read is history; later reads announce near, reached and reset once per window period", () => {
  const ok = [account("claude-personal", [["five_hour", "5-hour", 60, 2 * hour]])];
  expect(limitChanges(undefined, ok)).toEqual([]);

  const near = [account("claude-personal", [["five_hour", "5-hour", 91, 2 * hour]])];
  const [warned] = limitChanges(ok, near);
  expect(warned).toMatchObject({ kind: "near", window: { label: "5-hour", usedPercent: 91 } });
  // The same window creeping further is the same news.
  const nearer = [account("claude-personal", [["five_hour", "5-hour", 95, 2 * hour]])];
  expect(limitChanges(near, nearer)).toEqual([]);

  const full = [account("claude-personal", [["five_hour", "5-hour", 100, 2 * hour]])];
  expect(limitChanges(nearer, full)).toMatchObject([{ kind: "reached", resetsAt: now + 2 * hour }]);

  const fresh = [account("claude-personal", [["five_hour", "5-hour", 3, 7 * hour]])];
  expect(limitChanges(full, fresh)).toMatchObject([{ kind: "reset" }]);

  // A wobble back across the line names the same window period, so a caller can say it once.
  const again = limitChanges(
    [account("claude-personal", [["five_hour", "5-hour", 80, 2 * hour]])],
    near,
  );
  expect(again[0]?.key).toBe(warned?.key);
});

test("a signed-out account's limits are not news", () => {
  const before = [account("claude-personal", [["five_hour", "5-hour", 60, hour]])];
  const after = [
    account("claude-personal", [["five_hour", "5-hour", 100, hour]], { signedIn: false }),
  ];
  expect(limitChanges(before, after)).toEqual([]);
});

test("headroom names each provider's account with the most room and the next one to free up", () => {
  const rows = providerHeadroom([
    account("claude-personal", [
      ["five_hour", "5-hour", 62, 2 * hour],
      ["seven_day", "Weekly", 41, 4 * 24 * hour],
    ]),
    account("claude-work", [
      ["five_hour", "5-hour", 23, 3 * hour],
      ["seven_day", "Weekly", 57, 2 * 24 * hour],
    ]),
    account("codex-personal", [["five_hour", "5-hour", 38, 3 * hour]]),
    account("codex-team", [["five_hour", "5-hour", 100, 87 * minute]]),
    // Reports nothing to compare.
    { ...account("opencode-default", []), providerLabel: "OpenCode" },
  ]);
  expect(rows.map((row) => row.providerLabel)).toEqual(["Claude Code", "Codex"]);
  const [claude, codex] = rows;
  // Work's tightest window (Weekly, 57%) still leaves more than Personal's (5-hour, 62%).
  expect(claude).toMatchObject({ accounts: 2, available: 2, best: { left: 43 } });
  expect(claude?.best?.account.id).toBe("claude-work");
  expect(codex).toMatchObject({ accounts: 2, available: 1, nextReset: { at: now + 87 * minute } });
  expect(codex?.best?.account.id).toBe("codex-personal");
});

test("limited threads group by account with when it frees up and where they can move", () => {
  const accounts = [
    account("codex-team", [["five_hour", "5-hour", 100, 87 * minute]]),
    account("codex-personal", [["five_hour", "5-hour", 38, 3 * hour]]),
    account("claude-personal", [["five_hour", "5-hour", 100, hour]]),
  ];
  const groups = limitedGroups(
    [
      { id: "a", title: "A", account: "codex-team", until: undefined },
      { id: "b", title: "B", account: "claude-personal", until: undefined },
      { id: "c", title: "C", account: "codex-team", until: now + 30 * minute },
      { id: "d", title: "D", account: undefined, until: undefined },
    ],
    accounts,
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
    limitedGroups([{ id: "a", title: "A", account: "codex-team", until: undefined }], undefined)[0]
      ?.target,
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
  expect(atLimitLine("resume_at_reset", undefined)).toContain("resumes when the window resets");
});

test("quota is read again at the next reset of a window near or at its limit", () => {
  const accounts = [
    account("claude-personal", [
      ["five_hour", "5-hour", 40, 30 * minute],
      ["seven_day", "Weekly", 90, 3 * 24 * hour],
    ]),
    account("codex-team", [["five_hour", "5-hour", 100, 87 * minute]]),
  ];
  // The 5-hour window at 40% resetting sooner changes nothing worth a read.
  expect(nextLimitReset(accounts, now)).toBe(now + 87 * minute);
  expect(nextLimitReset([account("claude-work", [["five_hour", "5-hour", 20, hour]])], now)).toBe(
    undefined,
  );
});
