import type { AccountQuota } from "@ace/protocol/accounts";
import { expect, test } from "vitest";
import { createInstance } from "./instances.ts";
import { refusalWords } from "./refusal-words.ts";
import { explicitInstance, pickInstance, type Candidate } from "./scheduler.ts";

const now = Date.parse("2026-11-01T20:00:00Z");
const hour = 3_600_000;
const worker = { provider: "codex" as const, role: "worker", estimatedLoad: 10 };

function account(id: string, used: number | null, patch: Partial<AccountQuota> = {}): Candidate {
  return {
    instance: createInstance({ id, provider: "codex", label: id, homeDir: `/tmp/${id}` }),
    quota: {
      auth: "logged_in",
      observedAt: now,
      windows: used === null ? {} : { five_hour: { usedPercent: used, resetsAt: now + hour } },
      blockers: {},
      usage: {},
      ...patch,
    },
  };
}

test("an account someone names runs the work while it is near its limit", () => {
  const near = account("346", 92);
  expect(explicitInstance(worker, near, now)).toEqual({ instance: near.instance });
  // The person chose it, so an estimate above its remaining room doesn't refuse it either.
  expect(explicitInstance({ ...worker, estimatedLoad: 50 }, near, now)).toEqual({
    instance: near.instance,
  });
});

test("a named account whose sign-in isn't confirmed yet still runs the work", () => {
  const unread = account("fresh", null, { auth: "unknown" });
  expect(explicitInstance(worker, unread, now)).toEqual({ instance: unread.instance });
});

test("a named account at its limit is refused, saying until when", () => {
  const full = account("346", 100);
  const result = explicitInstance(worker, full, now);
  expect(result).toEqual({ refusal: { reason: "at_limit", until: now + hour } });
  if (!("refusal" in result)) return;
  expect(refusalWords("Codex account 346", result.refusal, now, "UTC")).toBe(
    "Codex account 346 is at its limit until 9:00 PM UTC",
  );
});

test("a named account that is signed out or has no usable home is refused for that reason", () => {
  expect(explicitInstance(worker, account("out", 10, { auth: "logged_out" }), now)).toEqual({
    refusal: { reason: "signed_out" },
  });
  expect(
    explicitInstance(
      worker,
      account("gone", 10, { blockers: { homeUnavailable: "home_missing" } }),
      now,
    ),
  ).toEqual({ refusal: { reason: "home_unavailable" } });
});

test("automatic choice prefers an available account over one near its limit", () => {
  const candidates = [account("near", 85), account("roomy", 40)];
  expect(pickInstance(worker, candidates, now)?.id).toBe("roomy");
});

test("when every account is near its limit, automatic choice takes the one with most room", () => {
  const candidates = [account("a", 95), account("b", 82), account("c", 90)];
  expect(pickInstance(worker, candidates, now)?.id).toBe("b");
});

test("automatic choice refuses only when no account is below its limit", () => {
  const candidates = [
    account("full", 100),
    account("out", 10, { auth: "logged_out" }),
    account("unread", null, { auth: "unknown" }),
  ];
  expect(pickInstance(worker, candidates, now)).toBeUndefined();
  expect(pickInstance(worker, [...candidates, account("near", 97)], now)?.id).toBe("near");
});
