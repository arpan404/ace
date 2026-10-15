import type { AccountQuota } from "@ace/protocol/accounts";
import { expect, test } from "vitest";
import { automaticTarget, availability, blockedUntil } from "./availability.ts";

const now = Date.parse("2026-10-01T15:00:00Z");
const hour = 3_600_000;

function quota(
  windows: Record<string, [used: number, resetsAt: number | null]>,
  patch: Partial<AccountQuota> = {},
): AccountQuota {
  return {
    auth: "logged_in",
    observedAt: now,
    windows: Object.fromEntries(
      Object.entries(windows).map(([name, [usedPercent, resetsAt]]) => [
        name,
        { usedPercent, resetsAt },
      ]),
    ),
    blockers: {},
    usage: {},
    ...patch,
  };
}

test("an account held by several full windows is free only once the last of them resets", () => {
  const held = quota({ five_hour: [100, now + hour], seven_day: [100, now + 72 * hour] });
  expect(blockedUntil(held, now)).toBe(now + 72 * hour);
  // Re-read after the 5-hour reset, the weekly window still holds it, to the same moment.
  const reread = { ...held, observedAt: now + 2 * hour };
  expect(blockedUntil(reread, now + 2 * hour)).toBe(now + 72 * hour);
  expect(availability(reread, now + 2 * hour)).toBe("exhausted");
  const later = { ...held, observedAt: now + 73 * hour };
  expect(blockedUntil(later, now + 73 * hour)).toBeUndefined();
  expect(availability(later, now + 73 * hour)).toBe("available");
});

test("a stale reading never holds an account at its limit", () => {
  const full = quota({ seven_day: [100, now + 72 * hour] });
  expect(availability(full, now + 29 * 60_000)).toBe("exhausted");
  // Nothing has been read for over half an hour: the provider may have reset or sold more.
  expect(availability(full, now + 31 * 60_000)).toBe("available");
  expect(blockedUntil(full, now + 31 * 60_000)).toBeUndefined();
  expect(availability(quota({ five_hour: [90, now + hour] }), now + hour / 2 + 1)).toBe(
    "available",
  );
});

test("an unknown or unreadable limit is not a limit", () => {
  // More windows than ace keeps, or a frame it could not certify: nothing definite was said.
  expect(availability(quota({}, { blockers: { overflow: true } }), now)).toBe("available");
  expect(blockedUntil(quota({}, { blockers: { overflow: true } }), now)).toBeUndefined();
});

test("the reset comes from what says when, and no time is promised when nothing does", () => {
  // A limit error with no time is explained by the full window that gives one.
  expect(
    blockedUntil(
      quota(
        { five_hour: [100, now + hour] },
        {
          blockers: { limitError: { usedPercent: 100, resetsAt: null } },
        },
      ),
      now,
    ),
  ).toBe(now + hour);
  expect(
    blockedUntil(
      quota(
        { seven_day: [100, null] },
        { blockers: { limitError: { usedPercent: 100, resetsAt: null } } },
      ),
      now,
    ),
  ).toBe(null);
  // A window short of full holds nothing.
  expect(blockedUntil(quota({ five_hour: [99, null] }), now)).toBeUndefined();
});

test("a provider's resetless limit stops holding the account once it is no longer fresh", () => {
  const limited = quota({}, { blockers: { limitError: { usedPercent: 100, resetsAt: null } } });
  expect(availability(limited, now)).toBe("exhausted");
  expect(availability(limited, now + 31 * 60_000)).toBe("available");
});

test("automatic recovery moves to the first other account of the provider that is available now", () => {
  const accounts = [
    { id: "codex-team", provider: "codex", quota: quota({ five_hour: [100, now + hour] }) },
    { id: "claude-work", provider: "claude", quota: quota({}) },
    { id: "codex-near", provider: "codex", quota: quota({ five_hour: [85, now + hour] }) },
    { id: "codex-unknown", provider: "codex", quota: quota({}, { auth: "unknown" }) },
    // Was full, but that window has reset.
    { id: "codex-reset", provider: "codex", quota: quota({ five_hour: [100, now - 1] }) },
    { id: "codex-roomy", provider: "codex", quota: quota({ five_hour: [5, now + hour] }) },
  ];
  expect(automaticTarget(accounts, { id: "codex-team", provider: "codex" }, now)?.id).toBe(
    "codex-reset",
  );
  expect(automaticTarget(accounts, { id: "claude-work", provider: "claude" }, now)).toBeUndefined();
});
