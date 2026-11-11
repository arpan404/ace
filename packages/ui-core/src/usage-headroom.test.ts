import { AccountSummary } from "@ace/protocol/accounts";
import { expect, test } from "vitest";
import { accountView } from "./accounts.ts";
import { headroomSentence, railUsage, usageHeadroom } from "./usage-headroom.ts";
import { usageLimits } from "./usage-limits.ts";

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
  weekly: 22,
};
const bars = (rail: { bars: { label: string; left: number; tone: string }[] }) =>
  rail.bars.map((bar) => [bar.label, bar.left, bar.tone]);

test("one account draws one bar of its week, named by its provider", () => {
  expect(bars(railUsage(limits(claudePersonal), undefined))).toEqual([["Claude Code", 59, "ok"]]);
});

test("the icon shows each account's week, most used first, filled to four", () => {
  const list = limits(
    claudePersonal,
    claudeWork,
    codexPersonal,
    { ...codexPersonal, id: "codex-team", label: "Team", isDefault: false, weekly: 100 },
    { ...codexPersonal, id: "codex-ci", label: "CI", isDefault: false, weekly: 85 },
  );
  const used = new Map([
    ["codex-ci", 900],
    ["claude-work", 500],
  ]);
  // Used this week first; the rest fill in the page's order. Each bar is the week left.
  expect(bars(railUsage(list, used))).toEqual([
    ["Codex · CI", 15, "low"],
    ["Claude Code · Work", 43, "ok"],
    ["Claude Code · Personal", 59, "ok"],
    ["Codex · Personal", 78, "ok"],
  ]);
});

test("an account with no weekly window shows its longest one, and a spent week reads out", () => {
  const sessionOnly: Seed = { ...claudeWork, weekly: undefined, session: [70, 120] };
  const spent = { ...codexPersonal, weekly: 100 };
  const rail = railUsage(limits(sessionOnly, spent), undefined);
  expect(bars(rail)).toEqual([
    ["Claude Code", 30, "ok"],
    ["Codex", 0, "out"],
  ]);
  expect(rail.label).toBe(
    "Usage: Claude Code 30% of the session (5h) left, Codex out for the week",
  );
});

test("the rail icon has no bars and says so with no usage data", () => {
  const empty = railUsage(limits(), undefined);
  expect(empty.bars).toEqual([]);
  expect(empty.label).toBe("Usage: no limits read yet");
});

test("the rail icon's name says each account's week in words", () => {
  const list = limits(claudePersonal, claudeWork, codexPersonal);
  expect(railUsage(list, undefined).label).toBe(
    "Usage: Claude Code · Personal 59% of the week left, Claude Code · Work 43%, Codex 78%",
  );
});

test("a session past its reset since its last reading counts as fresh", () => {
  const reset = account({ ...claudeWork, session: [80, 300] });
  const [stale] = usageHeadroom(
    usageLimits([{ account: reset, environment: "This Mac" }], now + 301 * minute),
  );
  // Fresh, but capped by its week (57% used).
  expect(stale?.sessionLeft).toBe(43);
});

test("with room everywhere, the card names the tightest provider and when it runs out at this pace", () => {
  const list = headroom(claudePersonal, {
    provider: "codex",
    id: "codex-personal",
    label: "Personal",
    isDefault: true,
    session: [38, 181],
  });
  expect(headroomSentence(list, now)).toBe(
    "Claude Code's session runs out in about 2h at this pace; it resets in 2h 1m.",
  );
});

test("a tightest provider on pace to last until its reset gets no forecast", () => {
  const list = headroom({ ...claudePersonal, session: [30, 60] });
  expect(headroomSentence(list, now)).toBe(
    "Claude Code is the tightest, with 59% of the session left; it resets in 1h.",
  );
});

test("the card says who is out on every account and when they're back", () => {
  const list = headroom(
    { ...claudePersonal, session: [100, 88] },
    { ...claudeWork, session: [100, 150] },
  );
  expect(headroomSentence(list, now)).toBe("Claude Code is out; it's back in 1h 28m.");
});

test("the card says nothing with no limits read", () => {
  expect(headroomSentence([], now)).toBe("No limits read yet.");
});

test("set to session, the bars show each account's usable session instead of its week", () => {
  const list = limits(claudePersonal, claudeWork, codexPersonal);
  const rail = railUsage(list, undefined, "session");
  // Sessions, each capped by its week: Work's fresh session is held to its 43% week.
  expect(bars(rail)).toEqual([
    ["Claude Code · Personal", 38, "ok"],
    ["Claude Code · Work", 43, "ok"],
    ["Codex", 10, "low"],
  ]);
  expect(rail.label).toBe(
    "Usage: Claude Code · Personal 38% of the session left, Claude Code · Work 43%, Codex 10%",
  );
});
