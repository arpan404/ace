import { describe, expect, it } from "vitest";
import type { ForgePrStatus } from "@ace/protocol";
import { fixingNow, liveFixMarks, type FixMark } from "./forge-fix-marks.ts";

type Thread = ForgePrStatus["reviewThreads"][number];
const head = "a".repeat(40);
const pushed = "b".repeat(40);
const asked = "2026-11-02T10:00:00Z";
const now = Date.parse("2026-11-02T11:00:00Z");
const comment = (createdAt: string) => ({
  kind: "inline" as const,
  id: Date.parse(createdAt),
  body: "Done",
  author: "me",
  file: "a.ts",
  line: 1,
  updatedAt: createdAt,
  createdAt,
  replyTo: null,
});
const thread = (extra: Partial<Thread> = {}): Thread => ({
  id: "T1",
  resolved: false,
  outdated: false,
  file: "a.ts",
  line: 1,
  comments: [comment("2026-11-01T09:00:00Z")],
  ...extra,
});
const mark: FixMark = { subject: "thread:T1", agentThreadId: "agent", headSha: head, at: asked };
const busy = () => true;

describe("Agent fixing this", () => {
  it("shows on the thread while its agent works", () => {
    const status = { headSha: head, reviewThreads: [thread()] };
    expect(fixingNow("thread:T1", [mark], status, busy, now)).toBe(true);
    expect(fixingNow("thread:T2", [mark], status, busy, now)).toBe(false);
  });

  it("says nothing while the agent isn't working, rather than claim it is", () => {
    const status = { headSha: head, reviewThreads: [thread()] };
    expect(fixingNow("thread:T1", [mark], status, () => false, now)).toBe(false);
  });

  it("stays through a push alone or a reply alone, and clears once the agent pushed and replied", () => {
    const replied = thread({
      comments: [comment("2026-11-01T09:00:00Z"), comment("2026-11-02T10:30:00Z")],
    });
    expect(liveFixMarks([mark], { headSha: pushed, reviewThreads: [thread()] }, now)).toHaveLength(
      1,
    );
    expect(liveFixMarks([mark], { headSha: head, reviewThreads: [replied] }, now)).toHaveLength(1);
    expect(liveFixMarks([mark], { headSha: pushed, reviewThreads: [replied] }, now)).toEqual([]);
  });

  it("clears when the thread is resolved or gone, a check's head moves, or a day passes", () => {
    const check: FixMark = { ...mark, subject: "check:42" };
    expect(
      liveFixMarks([mark], { headSha: head, reviewThreads: [thread({ resolved: true })] }, now),
    ).toEqual([]);
    expect(liveFixMarks([mark], { headSha: head, reviewThreads: [] }, now)).toEqual([]);
    expect(liveFixMarks([check], { headSha: head, reviewThreads: [] }, now)).toHaveLength(1);
    expect(liveFixMarks([check], { headSha: pushed, reviewThreads: [] }, now)).toEqual([]);
    expect(
      liveFixMarks([mark], { headSha: head, reviewThreads: [thread()] }, now + 24 * 3_600_000),
    ).toEqual([]);
  });
});
