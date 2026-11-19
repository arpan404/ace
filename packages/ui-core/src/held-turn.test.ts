import { expect, test } from "vitest";
import { describeProviderError } from "./error-display.ts";
import { heldTurn, heldTurnSentence, holdsTurn } from "./held-turn.ts";
import { queueNotice } from "./queue.ts";
import { queueActionPayload } from "./queue-actions.ts";
import { ThreadId } from "@ace/protocol";

const threadId = ThreadId.parse("01a19a13-6cc2-7246-8088-6e8a977457d6");

const now = new Date(2026, 9, 20, 23, 46).getTime();
const reset = new Date(2026, 9, 20, 23, 59).getTime();

test("a usage limit reads as one sentence with its reset time, and Continue resumes the turn", () => {
  const notice = queueNotice(
    { state: "limited", until: reset },
    { paused: true, reason: "limit", resumeAt: null },
    now,
  );
  const turn = heldTurn(notice, undefined, "Codex", now, "en-US");
  expect(turn && heldTurnSentence(turn)).toBe("Codex is out of usage until 11:59 PM");
  expect(turn?.carryOn).toEqual({ id: "resume_now", label: "Continue" });
  expect(turn?.atReset).toEqual({ id: "resume_at_reset", label: "Resume at reset" });
});

test("once the person chose to resume at reset, the strip says when and when it resets, with Cancel", () => {
  const notice = queueNotice(
    { state: "limited", until: reset },
    { paused: true, reason: "limit", resumeAt: reset },
    now,
  );
  const turn = heldTurn(notice, undefined, "Codex", now, "en-US");
  expect(turn && heldTurnSentence(turn)).toBe("Resumes at 11:59 PM when Codex resets · in 13m");
  expect(turn?.atReset).toBeUndefined();
  expect(turn?.cancel).toEqual({ id: "cancel_resume", label: "Cancel" });
});

test("Cancel goes back to the limited strip: its sentence, Resume at reset and Continue", () => {
  const scheduled = heldTurn(
    queueNotice(
      { state: "limited", until: reset },
      { paused: true, reason: "limit", resumeAt: reset },
      now,
    ),
    undefined,
    "Codex",
    now,
  );
  const cancel = scheduled?.cancel;
  expect(
    cancel && queueActionPayload(cancel, threadId, { revision: 4, paused: true, reason: "limit" }),
  ).toEqual({
    type: "thread.limit",
    threadId,
    expectedRevision: 4,
    action: "cancel_resume",
  });
  // What the daemon reports after it: the limit hold with no resume deadline.
  const after = heldTurn(
    queueNotice(
      { state: "limited", until: reset },
      { paused: true, reason: "limit", resumeAt: null },
      now,
    ),
    undefined,
    "Codex",
    now,
    "en-US",
  );
  expect(after && heldTurnSentence(after)).toBe("Codex is out of usage until 11:59 PM");
  expect(after?.cancel).toBeUndefined();
  expect(after?.atReset?.id).toBe("resume_at_reset");
});

test("a limit with no known reset says nothing it doesn't know", () => {
  const notice = queueNotice(
    { state: "limited" },
    { paused: true, reason: "limit", resumeAt: null },
    now,
  );
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
