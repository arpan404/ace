import { expect, test } from "vitest";
import { describeProviderError } from "./error-display.ts";
import { heldTurn, heldTurnSentence, holdsTurn } from "./held-turn.ts";
import { queueNotice } from "./queue.ts";

const now = new Date(2026, 9, 20, 23, 46).getTime();
const reset = new Date(2026, 9, 20, 23, 59).getTime();

test("a usage limit reads as one sentence with its reset time, and Continue resumes the turn", () => {
  const notice = queueNotice({ state: "limited", until: reset }, undefined, now);
  const turn = heldTurn(notice, undefined, "Codex", now, "en-US");
  expect(turn && heldTurnSentence(turn)).toBe("Codex is out of usage until 11:59 PM");
  expect(turn?.carryOn).toEqual({ id: "resume_now", label: "Continue" });
  expect(turn?.atReset).toEqual({ id: "resume_at_reset", label: "Resume at reset" });
});

test("once the person chose to resume at reset, the sentence says when it resumes", () => {
  const notice = queueNotice(
    { state: "limited", until: reset },
    { paused: true, reason: "limit", resumeAt: reset },
    now,
  );
  const turn = heldTurn(notice, undefined, "Codex", now, "en-US");
  expect(turn && heldTurnSentence(turn)).toBe("Codex is out of usage · resumes at 11:59 PM");
  expect(turn?.atReset).toBeUndefined();
});

test("a limit with no known reset says nothing it doesn't know", () => {
  const notice = queueNotice({ state: "limited" }, undefined, now);
  const turn = heldTurn(notice, undefined, "Claude", now);
  expect(turn && heldTurnSentence(turn)).toBe("Claude is out of usage");
  expect(turn?.atReset).toBeUndefined();
});

test("a turn that ended on a rate limit with no hold continues with the person's message", () => {
  const limit = describeProviderError({ text: "Rate limited", code: "rate_limit" });
  const turn = heldTurn(undefined, limit, "Claude", now);
  expect(turn && heldTurnSentence(turn)).toBe("Claude is rate limited");
  expect(turn?.carryOn).toEqual({ id: "continue", label: "Continue" });
  const auth = describeProviderError({ text: "Not logged in", code: "auth" });
  expect(heldTurn(undefined, auth, "Claude", now)).toBeUndefined();
});

test("a Stop, a restart and a manual pause are not limits: they stay where they were", () => {
  for (const reason of ["stopped", "restart"] as const) {
    const notice = queueNotice(undefined, { paused: true, reason, resumeAt: null }, now);
    expect(holdsTurn(notice)).toBe(false);
    expect(heldTurn(notice, undefined, "Codex", now)).toBeUndefined();
  }
  const manual = queueNotice(
    undefined,
    { paused: true, reason: "manual", resumeAt: null, pendingCount: 1 },
    now,
  );
  expect(holdsTurn(manual)).toBe(false);
});
