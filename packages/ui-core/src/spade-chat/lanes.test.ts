import { describe, expect, test } from "vitest";
import {
  parseSpadeLanes,
  spadeLaneCost,
  spadeLaneDetail,
  spadeLaneLive,
  spadeLaneRowState,
  spadeLanesNeedYou,
  spadeLanesPillWords,
} from "./index.ts";

describe("a bot's task lanes as Spade lists them", () => {
  test("read in Spade's order, with progress, cost and the moved mark", () => {
    const lanes = parseSpadeLanes(
      JSON.stringify({
        tasks: [
          {
            task: "l2",
            conversation: "l2",
            title: "Book flights to Lisbon",
            state: "needs_you",
            needs_you: true,
            progress: { done: 3, total: 4, verified: 3 },
            plan_step: "Pay and save the confirmation",
            started_ms: 10,
            cost_micros: 220_000,
            asks: ["m4"],
          },
          {
            task: "l1",
            conversation: "l1",
            title: "Draft the quarterly note",
            state: "working",
            moved: true,
            started_ms: 5,
            cost_micros: 610_000,
          },
          { task: "l3", conversation: "l3", title: "Clean up", state: "done", ended_ms: 99 },
        ],
      }),
    );
    expect(lanes.map((lane) => [lane.task, lane.state, lane.needsYou])).toEqual([
      ["l2", "needs_you", true],
      ["l1", "working", false],
      ["l3", "done", false],
    ]);
    expect(lanes[0]?.progress).toEqual({ done: 3, total: 4, verified: 3 });
    expect(lanes[0]?.planStep).toBe("Pay and save the confirmation");
    expect(lanes[1]?.moved).toBe(true);
    expect(lanes[2]?.endedMs).toBe(99);
    expect(lanes.filter(spadeLaneLive).map((lane) => lane.task)).toEqual(["l2", "l1"]);
  });

  test("a state this client doesn't know reads as working, never as ended", () => {
    const [lane] = parseSpadeLanes(
      JSON.stringify({ tasks: [{ task: "l1", conversation: "l1", state: "pondering" }] }),
    );
    expect(lane?.state).toBe("working");
    expect(lane && spadeLaneLive(lane)).toBe(true);
  });

  test("a row without an id is left out and a body that isn't a list reads empty", () => {
    expect(parseSpadeLanes(JSON.stringify({ tasks: [{ title: "no id" }] }))).toEqual([]);
    expect(parseSpadeLanes("not json")).toEqual([]);
  });
});

/** One task row as Spade would send it. */
const lane = (row: Record<string, unknown>) => {
  const [read] = parseSpadeLanes(
    JSON.stringify({ tasks: [{ task: "l", conversation: "l", ...row }] }),
  );
  if (!read) throw new Error("the row didn't parse");
  return read;
};

describe("a bot's task lanes in words", () => {
  test("the pill counts the tasks that haven't ended, and those waiting on the person", () => {
    const lanes = [
      lane({ state: "needs_you", needs_you: true }),
      lane({ state: "working" }),
      lane({ state: "queued" }),
      lane({ state: "done" }),
      lane({ state: "failed" }),
    ];
    expect(spadeLanesPillWords(lanes)).toBe("3 tasks · 1 needs you");
    expect(spadeLanesNeedYou(lanes)).toBe(true);
    expect(spadeLanesPillWords([lane({ state: "working" })])).toBe("1 task");
    expect(spadeLanesPillWords([lane({ state: "done" })])).toBe("Tasks");
  });

  test("a row reads its step and count while it runs, Queued, then its report", () => {
    const running = lane({
      state: "working",
      progress: { done: 2, total: 5, verified: 0 },
      plan_step: "Drafting the email to Dana",
    });
    expect(spadeLaneDetail(running)).toBe("2 of 5 · Drafting the email to Dana");
    expect(spadeLaneRowState(running)).toBe("working");
    expect(spadeLaneDetail(lane({ state: "queued" }))).toBe("Queued");
    const failed = lane({ state: "failed", report: "HubSpot's page wouldn't load" });
    expect(spadeLaneDetail(failed)).toBe("Stopped early: HubSpot's page wouldn't load");
    expect(spadeLaneRowState(failed)).toBe("failed");
    expect(spadeLaneDetail(lane({ state: "done", report: "214 files moved" }))).toBe(
      "214 files moved",
    );
    expect(spadeLaneRowState(lane({ state: "working", needs_you: true }))).toBe("human");
  });

  test("its cost reads in dollars, and nothing before it spent any", () => {
    expect(spadeLaneCost(lane({ state: "working", cost_micros: 380_000 }))).toBe("$0.38");
    expect(spadeLaneCost(lane({ state: "queued" }))).toBeUndefined();
  });
});
