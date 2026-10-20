import { describe, expect, it } from "vitest";
import { OffshiftRunCard } from "@ace/protocol/offshift";
import type { ThreadStatus } from "@ace/protocol/thread-status";
import { runMark, runNotice } from "./offshift-mark.ts";

function card(input: Partial<OffshiftRunCard> = {}): OffshiftRunCard {
  return OffshiftRunCard.parse({
    id: "run",
    outcome: "Outcome",
    outcomeTruncated: false,
    endpoint: "PR",
    phase: "delivery",
    blocker: null,
    version: 1,
    updatedAt: 1,
    revision: "r",
    criteria: [],
    criteriaCount: 1,
    pending: [],
    pendingCount: 0,
    ...input,
  });
}

describe("run mark", () => {
  it("is delivered only in delivery with nothing pending and no step to do", () => {
    expect(runMark(card()).state).toBe("delivered");
    expect(runMark(card({ phase: "review" })).state).toBe("open");
    expect(runMark(card({ pendingCount: 2 })).state).toBe("open");
    expect(runMark(card({ steps: [{ id: "report", title: "Report", state: "todo" }] })).state).toBe(
      "open",
    );
    expect(runMark(card({ blocker: "Which branch?" })).state).toBe("blocked");
  });

  it("carries the phase, the pending count and the playbook, never an id", () => {
    expect(runMark(card({ phase: "verify", pendingCount: 3, playbook: "fix" }))).toEqual({
      phase: "verify",
      state: "open",
      pendingCount: 3,
      playbook: "fix",
    });
  });
});

describe("run notice", () => {
  const live: ThreadStatus["state"][] = [
    "working",
    "needs_you",
    "waiting",
    "limited",
    "failed",
    "unresponsive",
    "new",
  ];
  const marks = {
    open: runMark(card({ phase: "verify", pendingCount: 1 })),
    blocked: runMark(card({ phase: "review", blocker: "Pick a name" })),
    delivered: runMark(card()),
  };

  it("says nothing while the tree has not settled, whatever the run", () => {
    for (const tree of live)
      for (const mark of Object.values(marks)) expect(runNotice(mark, tree)).toBeUndefined();
  });

  it("names where an open or blocked run stopped once the tree is done", () => {
    expect(runNotice(marks.open, "done")).toEqual({
      outcome: "stopped",
      phase: "verify",
      headline: "Run stopped at Verify",
    });
    expect(runNotice(marks.blocked, "done")).toEqual({
      outcome: "blocked",
      phase: "review",
      headline: "Run blocked at Review",
    });
    expect(runNotice(marks.delivered, "done")).toMatchObject({
      outcome: "delivered",
      headline: "Run delivered",
    });
  });
});
