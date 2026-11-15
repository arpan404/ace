import { AccountSummary } from "@ace/protocol/accounts";
import { expect, test } from "vitest";
import { accountView } from "./accounts.ts";
import type { AccountWindow } from "./usage-limits.ts";
import { usageLimits } from "./usage-limits.ts";
import { comingUp, limitCardLine, limitLine } from "./usage-when.ts";

// A Saturday, 16:00 UTC.
const now = Date.parse("2026-11-14T16:00:00Z");
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

const window = (extra: Partial<AccountWindow>): AccountWindow => ({
  id: "w",
  label: "Session (5h)",
  leftPercent: 60,
  resetsAt: now + 3 * hour,
  pace: "on_pace",
  observedAt: now,
  stale: false,
  evenLeftPercent: 60,
  runsOutAt: null,
  startsAt: now - 2 * hour,
  leftAtReset: 20,
  ...extra,
});
const page = (extra: Partial<AccountWindow>) => limitLine(window(extra), now, "UTC", "en-GB");
const card = (extra: Partial<AccountWindow>) => limitCardLine(window(extra), now, "UTC", "en-GB");

test("a window that runs out before it resets says both when it runs out and when it's back", () => {
  expect(
    page({ leftPercent: 12, runsOutAt: now + 3 * hour + 23 * minute, resetsAt: now + 6 * day }),
  ).toEqual({
    lead: "Out ~19:25",
    rest: "back Fri 16:00",
    strong: true,
    spoken: "Runs out around 19:25, back Fri 16:00",
  });
  expect(
    card({ leftPercent: 12, runsOutAt: now + 2 * hour, resetsAt: now + 2 * hour + 10 * minute }),
  ).toMatchObject({
    lead: "Out ~18:00",
    rest: "back 18:10",
    strong: true,
  });
});

test("a window that is out says so and when it's back", () => {
  expect(page({ leftPercent: 0, resetsAt: now + 87 * minute })).toMatchObject({
    lead: "Out now",
    rest: "back 17:27",
    strong: true,
  });
  expect(card({ leftPercent: 0, resetsAt: now + 87 * minute })).toMatchObject({
    lead: "Back 17:27",
    strong: true,
  });
});

test("a window that lasts says when it resets, with a countdown within a day and a weekday beyond", () => {
  expect(page({})).toMatchObject({ lead: "Resets 19:00", rest: "in 3h", strong: false });
  expect(page({ resetsAt: now + 4 * day })).toMatchObject({
    lead: "Resets Wed 16:00",
    rest: undefined,
  });
  expect(card({}).lead).toBe("Resets in 3h");
  expect(card({ resetsAt: now + 4 * day })).toMatchObject({
    lead: "Resets Wed",
    spoken: "Resets Wed 16:00",
  });
});

test("a window not used since its reset says that, never a time", () => {
  expect(page({ stale: true }).lead).toBe("Not used since its reset");
  expect(card({ stale: true }).lead).toBe("Not used yet");
});

function account(id: string, label: string, windows: Record<string, unknown>, banked?: number) {
  return accountView(
    AccountSummary.parse({
      id,
      provider: "codex",
      label,
      availability: "available",
      quota: {
        auth: "logged_in",
        observedAt: now,
        windows,
        usage: {},
        ...(banked === undefined
          ? {}
          : { resetCredits: { available: banked, nextExpiresAt: null } }),
      },
    }),
  );
}

test("coming up lists windows running out and coming back across accounts, soonest first, with banked resets", () => {
  const limits = usageLimits(
    [
      account(
        "team",
        "Team",
        {
          five_hour: { usedPercent: 100, resetsAt: now + 87 * minute, windowDurationMins: 300 },
          // Seven-eighths of a week gone in its first day: out within hours, back in six days.
          seven_day: { usedPercent: 88, resetsAt: now + 6 * day, windowDurationMins: 10080 },
        },
        1,
      ),
      // Plenty left: nothing to say.
      account("personal", "Personal", {
        five_hour: { usedPercent: 10, resetsAt: now + 4 * hour, windowDurationMins: 300 },
      }),
    ].map((view) => ({ account: view, environment: "This Mac" })),
    now,
  );
  const events = comingUp(limits, now, "UTC", "en-GB");
  expect(events.map((event) => [event.time, event.what, event.after, event.banked])).toEqual([
    ["17:27", "Codex · Team session is back", "in 1h 27m", 1],
    [expect.stringMatching(/^~\d\d:\d\d$/), "Codex · Team weekly runs out", "back Fri 16:00", 1],
  ]);
});
