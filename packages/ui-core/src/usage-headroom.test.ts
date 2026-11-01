import { AccountSummary } from "@ace/protocol/accounts";
import { expect, test } from "vitest";
import { accountView } from "./accounts.ts";
import { headroomSentence, railUsage, usageHeadroom, usageNow } from "./usage-headroom.ts";
import { usageLimits } from "./usage-limits.ts";
import { usageSuggestion } from "./usage-suggestion.ts";

const now = Date.parse("2026-11-01T12:00:00Z");
const minute = 60_000;
const hour = 60 * minute;

interface Seed {
  provider: "claude" | "codex";
  id: string;
  label: string;
  isDefault?: boolean;
  /** Session used, and minutes until it resets (of 300). */
  session: [used: number, resetsInMins: number] | null;
  weekly?: number | undefined;
  signInLapsed?: boolean;
}

function account(seed: Seed) {
  const windows: Record<string, unknown> = {};
  if (seed.session)
    windows.five_hour = {
      usedPercent: seed.session[0],
      resetsAt: now + seed.session[1] * minute,
      windowDurationMins: 300,
    };
  if (seed.weekly !== undefined)
    windows.seven_day = {
      usedPercent: seed.weekly,
      resetsAt: now + 4 * 24 * hour,
      windowDurationMins: 10080,
    };
  return accountView(
    AccountSummary.parse({
      id: seed.id,
      provider: seed.provider,
      label: seed.label,
      availability: "available",
      ...(seed.isDefault ? { isDefault: true } : {}),
      quota: {
        auth: "logged_in",
        observedAt: now,
        windows,
        usage: {},
        ...(seed.signInLapsed
          ? {
              usageNotice: {
                reason: "signed_out",
                message: "Sign in again in Claude Code",
                observedAt: now,
              },
            }
          : {}),
      },
    }),
  );
}

const limits = (...seeds: Seed[]) =>
  usageLimits(
    seeds.map((seed) => ({ account: account(seed), environment: "This Mac" })),
    now,
  );
const headroom = (...seeds: Seed[]) => usageHeadroom(limits(...seeds));

const claudePersonal: Seed = {
  provider: "claude",
  id: "claude-personal",
  label: "Personal",
  isDefault: true,
  // 62% used three hours into five: runs out before the reset.
  session: [62, 121],
  weekly: 41,
};
const claudeWork: Seed = {
  provider: "claude",
  id: "claude-work",
  label: "Work",
  session: [0, 300],
  weekly: 57,
};

test("a provider's pooled session is its best account's room, capped by that account's week", () => {
  const [claude] = headroom(claudePersonal, claudeWork);
  expect(claude?.sessionLeft).toBe(43);
  expect(claude?.currentLeft).toBe(38);
  expect(claude?.best?.account.label).toBe("Work");
  // A fresh session on an account whose week is spent can't take work.
  const [spent] = headroom({ ...claudeWork, weekly: 100, isDefault: true });
  expect(spent?.sessionLeft).toBe(0);
});

test("an account whose sign-in lapsed or whose session can't be read doesn't count", () => {
  const [claude] = headroom({ ...claudeWork, signInLapsed: true }, claudePersonal);
  expect(claude?.sessionLeft).toBe(38);
  const [none] = headroom({ ...claudePersonal, session: null, weekly: undefined });
  expect(none?.sessionLeft ?? null).toBeNull();
});

const codexPersonal: Seed = {
  provider: "codex",
  id: "codex-personal",
  label: "Personal",
  isDefault: true,
  session: [90, 60],
};
const bars = (rail: { bars: { label: string; left: number; tone: string }[] }) =>
  rail.bars.map((bar) => [bar.label, bar.left, bar.tone]);

test("one account draws one bar, named by its provider", () => {
  expect(bars(railUsage(limits(claudePersonal), undefined))).toEqual([["Claude Code", 38, "ok"]]);
});

test("the icon grows a bar per account, most used first, up to four", () => {
  const list = limits(
    claudePersonal,
    claudeWork,
    codexPersonal,
    { ...codexPersonal, id: "codex-team", label: "Team", isDefault: false, session: [100, 88] },
    { ...codexPersonal, id: "codex-ci", label: "CI", isDefault: false, session: [10, 88] },
  );
  const used = new Map([
    ["codex-personal", 900],
    ["claude-work", 500],
    ["codex-team", 400],
    ["claude-personal", 300],
    ["codex-ci", 100],
  ]);
  // Each bar is that account's own room: its session capped by its week.
  expect(bars(railUsage(list, used))).toEqual([
    ["Codex · Personal", 10, "low"],
    ["Claude Code · Work", 43, "ok"],
    ["Codex · Team", 0, "out"],
    ["Claude Code · Personal", 38, "ok"],
  ]);
  // An account not used this week drops out of the icon.
  expect(bars(railUsage(list, new Map([["claude-work", 5]])))).toEqual([
    ["Claude Code · Work", 43, "ok"],
  ]);
});

test("the rail icon has no bars and says so with no usage data", () => {
  const empty = railUsage(limits(), undefined);
  expect(empty.bars).toEqual([]);
  expect(empty.label).toBe("Usage: no limits read yet");
});

test("the rail icon's name says each account's room in words", () => {
  const list = limits(claudePersonal, { ...codexPersonal, session: [100, 88] });
  expect(railUsage(list, undefined).label).toBe(
    "Usage: Claude Code 38% of session left, Codex out",
  );
});

test("with room everywhere, Now names the tightest provider and when it runs out at this pace", () => {
  const list = headroom(claudePersonal, {
    provider: "codex",
    id: "codex-personal",
    label: "Personal",
    isDefault: true,
    session: [38, 181],
  });
  const line = usageNow(list, now);
  expect(line?.text).toBe(
    "You have room on every provider. Claude Code is the tightest: 38% of the session left, out in about 2h at this pace.",
  );
  expect(line?.parts.find((part) => part.strong)?.text).toBe("Claude Code");
  expect(headroomSentence(list, now)).toBe(
    "Claude Code's session runs out in about 2h at this pace; it resets in 2h 1m.",
  );
});

test("a tightest provider on pace to last until its reset gets no forecast", () => {
  const list = headroom({ ...claudePersonal, session: [30, 60] });
  expect(usageNow(list, now)?.text).toBe(
    "You have room on every provider. Claude Code is the tightest: 59% of the session left.",
  );
  expect(headroomSentence(list, now)).toBe(
    "Claude Code is the tightest, with 59% of the session left; it resets in 1h.",
  );
});

test("Now says who is out on every account and when they're back", () => {
  const list = headroom(
    { ...claudePersonal, session: [100, 88] },
    { ...claudeWork, session: [100, 150] },
  );
  expect(usageNow(list, now)?.text).toBe(
    "Claude Code is out on every account; it's back in 1h 28m.",
  );
  expect(headroomSentence(list, now)).toBe("Claude Code is out; it's back in 1h 28m.");
});

test("Now says when the account for new threads is out though another has room", () => {
  const list = headroom({ ...claudePersonal, session: [100, 88] }, claudeWork);
  expect(usageNow(list, now)?.text).toBe(
    "Claude Code's Personal account is out; it's back in 1h 28m.",
  );
  expect(usageSuggestion(list, "claude:")?.text).toBe(
    "Its Work account has 43% of its session left.",
  );
});

test("Now says nothing with no limits read", () => {
  expect(usageNow([], now)).toBeUndefined();
  expect(headroomSentence([], now)).toBe("No limits read yet.");
});

test("another account with clearly more room is suggested as the default", () => {
  const list = headroom(claudePersonal, { ...claudeWork, weekly: 0 });
  const suggestion = usageSuggestion(list, "claude:");
  expect(suggestion?.text).toBe("Its Work account has a fresh session.");
  expect(suggestion?.action).toBe("Make Work the default for new Claude threads");
  expect(suggestion?.account.account.id).toBe("claude-work");
  // No suggestion when the default already has room, or is the best.
  expect(usageSuggestion(headroom({ ...claudePersonal, session: [10, 200] }, claudeWork))).toBe(
    undefined,
  );
  expect(usageSuggestion(headroom(claudePersonal))).toBeUndefined();
});
