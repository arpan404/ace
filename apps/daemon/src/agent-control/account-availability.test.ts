import { expect, test } from "vitest";
import { createInstance, type Candidate } from "@ace/accounts";
import { accountLaunchRefusal } from "./account-availability.ts";

const now = Date.parse("2026-11-04T12:00:00Z");
function account(id: string, used?: number): Candidate {
  return {
    instance: createInstance({
      id,
      provider: "codex",
      label: `Label-${id}`,
      homeDir: `/tmp/${id}`,
    }),
    quota: {
      auth: "unknown",
      observedAt: now,
      windows:
        used === undefined ? {} : { five_hour: { usedPercent: used, resetsAt: now + 3600000 } },
      blockers: {},
      usage: {},
    },
  };
}

test.each([undefined, 20, 99, 100])(
  "an account with usage %s is refused only when definitely exhausted",
  (used) => {
    const result = accountLaunchRefusal([account("selected", used)], "selected", now);
    if (used === 100) {
      expect(result).toContain("Label-selected (selected)");
      expect(result).toContain("1:00 PM UTC");
    } else expect(result).toBeUndefined();
  },
);

test("a refusal names usable and unread alternatives on the same provider, excluding disabled and exhausted accounts", () => {
  const candidates = [
    account("selected", 100),
    account("available", 10),
    account("unread"),
    account("disabled", 10),
    account("exhausted", 100),
  ];
  const result = accountLaunchRefusal(candidates, "selected", now, (id) => id !== "disabled");
  expect(result).toContain("Label-available (available)");
  expect(result).toContain("Label-unread (unread)");
  expect(result).not.toContain("Label-disabled");
  expect(result).not.toContain("Label-exhausted");
});

test("an unregistered account or an expired reading allows launch", () => {
  expect(accountLaunchRefusal([], "selected", now)).toBeUndefined();
  expect(
    accountLaunchRefusal([account("selected", 100)], "selected", now + 3600001),
  ).toBeUndefined();
});

test("only a used-up limit refuses here: a signed-out account is left to the sign-in check, and is never offered instead", () => {
  const signedOut = (id: string, used?: number): Candidate => {
    const entry = account(id, used);
    return { ...entry, quota: { ...entry.quota, auth: "logged_out" } };
  };
  expect(accountLaunchRefusal([signedOut("selected", 20)], "selected", now)).toBeUndefined();
  const result = accountLaunchRefusal(
    [account("selected", 100), signedOut("signed-out", 10), account("ready", 10)],
    "selected",
    now,
  );
  expect(result).toContain("Label-ready (ready)");
  expect(result).not.toContain("Label-signed-out");
});
