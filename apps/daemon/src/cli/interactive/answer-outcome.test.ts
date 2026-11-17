import { describe, expect, it } from "vitest";
import { answerOutcome, answerPatienceMs } from "./answer-outcome.ts";

describe("what the person hears after answering a request", () => {
  const sent = { sentAt: 1_000, done: "Allow once: Run bun install" };

  it("claims the answer only once the request is resolved", () => {
    expect(answerOutcome({ ...sent, state: "pending", now: 2_000 })).toEqual({ kind: "waiting" });
    expect(answerOutcome({ ...sent, state: "resolved", now: 2_000 })).toEqual({
      kind: "done",
      text: "Allow once: Run bun install",
    });
  });

  it("says the answer didn't land when the request closed another way", () => {
    for (const state of ["cancelled", "expired"] as const) {
      const outcome = answerOutcome({ ...sent, state, now: 2_000 });
      expect(outcome.kind).toBe("failed");
      expect(outcome).toMatchObject({ text: expect.stringContaining("Nothing was answered") });
    }
  });

  it("says the request is still open when nothing confirmed the answer in time", () => {
    const outcome = answerOutcome({
      ...sent,
      state: "pending",
      now: sent.sentAt + answerPatienceMs,
    });
    expect(outcome).toMatchObject({ kind: "failed", text: expect.stringContaining("still open") });
    expect(outcome).not.toMatchObject({ text: expect.stringContaining("Allow once") });
  });
});
