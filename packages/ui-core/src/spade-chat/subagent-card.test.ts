import { expect, test } from "vitest";
import type { SubagentState } from "../subagents.ts";
import {
  spadeShownSubagents,
  spadeSubagentHeader,
  spadeSubagentLine,
  spadeSubagentName,
  spadeSubagentsNeedYou,
  spadeSubagentsSpan,
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

test("the header says the bot worked with its agents once every one ended", () => {
  expect(spadeSubagentHeader("Quill", ["done", "failed", "done", "cancelled"], current)).toBe(
    "Quill worked with 4 agents",
  );
  expect(spadeSubagentHeader("Quill", ["done"], current)).toBe("Quill worked with 1 agent");
});

test("a copy that isn't current never reads finished, even when every agent last said done", () => {
  expect(spadeSubagentHeader("Quill", ["done", "done"], { current: false })).toBe(
    "Quill is working with 2 agents",
  );
});

test("the header counts the agents waiting on the person, and says nothing when none do", () => {
  expect(spadeSubagentsNeedYou(["working", "human", "done", "human"])).toBe("2 needs you");
  expect(spadeSubagentsNeedYou(["working", "done"])).toBeUndefined();
});

test("the agents' time runs from the first start, and ends only once every one has ended", () => {
  expect(
    spadeSubagentsSpan([
      { startedAt: 10, endedAt: 50 },
      { startedAt: 5, endedAt: 90 },
    ]),
  ).toEqual({ startedAt: 5, endedAt: 90 });
  expect(spadeSubagentsSpan([{ startedAt: 10, endedAt: 50 }, { startedAt: 5 }])).toEqual({
    startedAt: 5,
    endedAt: undefined,
  });
  expect(spadeSubagentsSpan([{}])).toBeUndefined();
});

test("a slug reads as words: the bot's own name dropped, spaces for dashes, sentence case", () => {
  expect(spadeSubagentName("Research-pricing", "Research")).toBe("Pricing");
  expect(spadeSubagentName("research_feature-tables", "Research")).toBe("Feature tables");
  expect(spadeSubagentName("Market-germany", "Survey")).toBe("Market germany");
  // A name a person wrote keeps its capitals; one that is only the bot's name stays as it is.
  expect(spadeSubagentName("Compare G2 reviews", "Research")).toBe("Compare G2 reviews");
  expect(spadeSubagentName("Research", "Research")).toBe("Research");
  expect(spadeSubagentName("Researcher-notes", "Research")).toBe("Researcher notes");
});

test("a working agent's second line is its live phrase, plain Working when it says nothing", () => {
  expect(
    spadeSubagentLine({
      kind: "bot",
      state: "working",
      status: "**Reading** the G2 and Capterra reviews for the top three vendors",
    }),
  ).toEqual({ text: "Reading the G2 and Capterra reviews", tone: "working", live: true });
  expect(spadeSubagentLine({ kind: "ace", state: "working" }).text).toBe("Working");
  expect(spadeSubagentLine({ kind: "bot", state: "working", status: "Thinking" }).text).toBe(
    "Working",
  );
});

test("an agent waiting on the person says what it waits for, in the needs-you tone", () => {
  const plan = { kind: "ace" as const, state: "human" as const, asking: "plan_review" };
  expect(spadeSubagentLine({ ...plan, detail: "Reading the pricing pages" })).toEqual({
    text: "Wants you to approve its plan",
    tone: "needs-you",
    live: false,
  });
  expect(spadeSubagentLine({ kind: "bot", state: "human" }).text).toBe("Needs you");
});

test("a finished agent shows what it found, else Done; a bot's old status is dropped", () => {
  const said = "Two of the four answer support within an hour; the notes are in support.md.";
  expect(spadeSubagentLine({ kind: "ace", state: "done", detail: said })).toEqual({
    text: said,
    tone: "settled",
    live: false,
  });
  expect(spadeSubagentLine({ kind: "ace", state: "done" }).text).toBe("Done");
  expect(spadeSubagentLine({ kind: "bot", state: "done", status: "Writing" }).text).toBe("Done");
});

test("a failed agent says Failed and why, in the failed tone", () => {
  expect(
    spadeSubagentLine({ kind: "ace", state: "failed", detail: "Hit the usage limit" }),
  ).toEqual({ text: "Failed · Hit the usage limit", tone: "failed", live: false });
  expect(spadeSubagentLine({ kind: "bot", state: "failed" }).text).toBe("Failed");
});

test("more than five agents fold the rest, and one waiting on the person is never folded", () => {
  const states: SubagentState[] = ["done", "done", "done", "working", "done", "done", "human"];
  expect(spadeShownSubagents(states, false)).toEqual({ shown: [0, 1, 2, 3, 6], hidden: 2 });
  expect(spadeShownSubagents(states, true)).toEqual({ shown: [0, 1, 2, 3, 4, 5, 6], hidden: 0 });
  expect(spadeShownSubagents(states.slice(0, 5), false).hidden).toBe(0);
});
