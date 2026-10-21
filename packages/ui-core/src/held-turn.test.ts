import { expect, test } from "vitest";
import { describeProviderError } from "./error-display.ts";
import { heldTurn, holdsTurn } from "./held-turn.ts";
import { queueNotice } from "./queue.ts";

const now = 1_000_000;
const hour = 60 * 60 * 1000;

test("a usage limit reads in one short line, with Continue first and the rest after it", () => {
  const notice = queueNotice({ state: "limited", until: now + hour + 28 * 60_000 }, undefined, now);
  const turn = heldTurn(notice, undefined, now);
  expect(turn).toMatchObject({ title: "Usage limit reached", detail: "Resets in 1h 28m" });
  expect(turn?.actions[0]).toEqual({ id: "resume_now", label: "Continue" });
  expect(turn?.actions.map((action) => action.id)).toContain("resume_at_reset");
});

test("a limit with no known reset says nothing it doesn't know", () => {
  const notice = queueNotice({ state: "limited" }, undefined, now);
  expect(heldTurn(notice, undefined, now)?.detail).toBe("");
});

test("a turn that ended on a rate limit with no hold offers Continue; other failures don't", () => {
  const limit = describeProviderError({ text: "Rate limited", code: "rate_limit" });
  expect(heldTurn(undefined, limit, now)).toMatchObject({
    title: "Rate limited",
    actions: [{ id: "continue", label: "Continue" }],
  });
  const auth = describeProviderError({ text: "Not logged in", code: "auth" });
  expect(heldTurn(undefined, auth, now)).toBeUndefined();
});

test("a Stop, a restart and a manual pause are not limits: they stay where they were", () => {
  for (const reason of ["stopped", "restart"] as const) {
    const notice = queueNotice(undefined, { paused: true, reason, resumeAt: null }, now);
    expect(holdsTurn(notice)).toBe(false);
    expect(heldTurn(notice, undefined, now)).toBeUndefined();
  }
  const manual = queueNotice(
    undefined,
    { paused: true, reason: "manual", resumeAt: null, pendingCount: 1 },
    now,
  );
  expect(holdsTurn(manual)).toBe(false);
});
