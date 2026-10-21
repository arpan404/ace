import { expect, test } from "vitest";
import { describeProviderError } from "./error-display.ts";
import { heldTurn, holdsTurn } from "./held-turn.ts";
import { queueNotice } from "./queue.ts";

const now = 1_000_000;

test("a paused turn reads Paused in amber with Continue, and leaves the queue's strip", () => {
  const notice = queueNotice(undefined, { paused: true, reason: "stopped", resumeAt: null }, now);
  expect(holdsTurn(notice)).toBe(true);
  expect(heldTurn(notice, undefined)).toMatchObject({
    title: "Paused",
    tone: "needs-you",
    actions: [{ id: "continue", label: "Continue" }],
  });
});

test("a usage limit hold is violet and keeps its ways out", () => {
  const notice = queueNotice({ state: "limited", until: now + 60_000 }, undefined, now);
  const turn = heldTurn(notice, undefined);
  expect(turn?.tone).toBe("waiting");
  expect(turn?.actions.map((action) => action.id)).toContain("resume_now");
});

test("a turn that ended on a rate limit with no hold offers Continue; other failures don't", () => {
  const limit = describeProviderError({ text: "Rate limited", code: "rate_limit" });
  expect(heldTurn(undefined, limit)).toMatchObject({
    tone: "waiting",
    actions: [{ id: "continue", label: "Continue" }],
  });
  const auth = describeProviderError({ text: "Not logged in", code: "auth" });
  expect(heldTurn(undefined, auth)).toBeUndefined();
});

test("a manual queue pause and a message not sent stay with the queue", () => {
  const manual = queueNotice(
    undefined,
    { paused: true, reason: "manual", resumeAt: null, pendingCount: 1 },
    now,
  );
  expect(holdsTurn(manual)).toBe(false);
  expect(heldTurn(manual, undefined)).toBeUndefined();
});
