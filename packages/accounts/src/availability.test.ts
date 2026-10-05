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
  // After the 5-hour reset the weekly window still holds it, to the same moment.
  expect(blockedUntil(held, now + 2 * hour)).toBe(now + 72 * hour);
  expect(availability(held, now + 2 * hour)).toBe("exhausted");
  expect(blockedUntil(held, now + 73 * hour)).toBeUndefined();
  expect(availability(held, now + 73 * hour)).toBe("available");
});

test("no time is promised when anything holding the account didn't say when it resets", () => {
  expect(blockedUntil(quota({ five_hour: [100, now + hour], seven_day: [100, null] }), now)).toBe(
    null,
  );
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
  ).toBe(null);
  expect(blockedUntil(quota({}, { blockers: { overflow: true } }), now)).toBe(null);
  // A window short of full holds nothing.
  expect(blockedUntil(quota({ five_hour: [99, null] }), now)).toBeUndefined();
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
