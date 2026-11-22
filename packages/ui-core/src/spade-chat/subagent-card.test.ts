import { expect, test } from "vitest";
import type { SubagentState } from "../subagents.ts";
import {
  spadeShownSubagents,
  spadeSubagentHeader,
  spadeSubagentsSpan,
  spadeSubagentStateWords,
  spadeSubagentStep,
} from "./index.ts";

const current = { current: true };

test("the header never reads finished while an agent works or waits on the person", () => {
  const unsettled: SubagentState[][] = [
    ["done", "done", "working"],
    ["done", "human", "done"],
    ["queued", "done"],
    ["done", "waiting"],
  ];
  for (const states of unsettled)
    expect(spadeSubagentHeader("Quill", states, current)).toBe(
      `Quill is working with ${states.length} agents`,
    );
});

test("the header says how long the agents took once every one ended", () => {
  const span = { startedAt: 0, endedAt: 12 * 60_000 };
  expect(
    spadeSubagentHeader("Quill", ["done", "failed", "done", "cancelled"], { ...current, span }),
  ).toBe("Quill worked with 4 agents · 12m");
  expect(spadeSubagentHeader("Quill", ["done"], current)).toBe("Quill worked with 1 agent");
  const instant = { startedAt: 5, endedAt: 400 };
  expect(spadeSubagentHeader("Quill", ["done"], { ...current, span: instant })).toBe(
    "Quill worked with 1 agent",
  );
});

test("a copy that isn't current never reads finished, even when every agent last said done", () => {
  expect(spadeSubagentHeader("Quill", ["done", "done"], { current: false })).toBe(
    "Quill is working with 2 agents",
  );
});

test("the span is known only once every agent has ended", () => {
  expect(
    spadeSubagentsSpan([
      { startedAt: 10, endedAt: 50 },
      { startedAt: 5, endedAt: 90 },
    ]),
  ).toEqual({ startedAt: 5, endedAt: 90 });
  expect(spadeSubagentsSpan([{ startedAt: 10, endedAt: 50 }, { startedAt: 5 }])).toBeUndefined();
});

test("an agent waiting on the person says what it waits for, and nothing more", () => {
  const plan = { kind: "ace" as const, state: "human" as const, asking: "plan_review" };
  expect(spadeSubagentStateWords(plan)).toBe("Waiting for you to approve its plan");
  expect(spadeSubagentStep({ ...plan, detail: "Reading the pricing pages" })).toBeUndefined();
  expect(spadeSubagentStateWords({ kind: "bot", state: "human" })).toBe("Waiting for you");
});

test("a working agent's step is the short Working phrase, and a bare Working adds nothing", () => {
  expect(
    spadeSubagentStep({
      kind: "bot",
      state: "working",
      status: "**Reading** the G2 and Capterra reviews for the top three vendors",
    }),
  ).toBe("Reading the G2 and Capterra reviews");
  expect(spadeSubagentStep({ kind: "bot", state: "working", status: "Thinking" })).toBeUndefined();
  expect(spadeSubagentStep({ kind: "ace", state: "working", detail: undefined })).toBeUndefined();
});

test("an ace agent that ended keeps what it said last; a bot's old status is dropped", () => {
  const said = "Two of the four answer support within an hour; the notes are in support.md.";
  expect(spadeSubagentStep({ kind: "ace", state: "done", detail: said })).toBe(said);
  expect(spadeSubagentStep({ kind: "bot", state: "done", status: "Writing" })).toBeUndefined();
});

test("more than five agents fold the rest, and one waiting on the person is never folded", () => {
  const states: SubagentState[] = ["done", "done", "done", "working", "done", "done", "human"];
  expect(spadeShownSubagents(states, false)).toEqual({ shown: [0, 1, 2, 3, 6], hidden: 2 });
  expect(spadeShownSubagents(states, true)).toEqual({ shown: [0, 1, 2, 3, 4, 5, 6], hidden: 0 });
  expect(spadeShownSubagents(states.slice(0, 5), false).hidden).toBe(0);
});
