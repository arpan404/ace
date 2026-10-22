import type { Question } from "@ace/protocol";
import { expect, test } from "vitest";
import { closedMeta, closedQuestionWords } from "./question-line.ts";

const indent: Question = {
  id: "q1",
  text: "Tabs or spaces?",
  options: [
    { id: "tabs", label: "Tabs" },
    { id: "spaces", label: "Spaces" },
  ],
  multiSelect: false,
  allowOther: true,
  secret: false,
};

test("an answered question's line carries the options picked and anything typed", () => {
  const resolution = { kind: "question", answers: { q1: ["tabs", "two wide"] } } as const;
  const meta = closedMeta({ state: "resolved", resolution }, false);
  expect(closedQuestionWords([indent], resolution, meta)).toEqual({
    answer: "Tabs, two wide",
    outcome: undefined,
  });
});

test("a skipped question shows no answer, only that it was skipped and why", () => {
  const resolution = {
    kind: "question",
    answers: { q1: ["tabs"] },
    dismissed: true,
    feedback: "  later ",
  } as const;
  const meta = closedMeta({ state: "resolved", resolution }, true);
  expect(closedQuestionWords([indent], resolution, meta)).toEqual({
    answer: "",
    outcome: "Skipped · “later”",
  });
});

test("a question that closed unanswered says how it ended", () => {
  const expired = closedMeta({ state: "expired" }, false);
  expect(closedQuestionWords([indent], undefined, expired).outcome).toBe(
    "Expired before an answer",
  );
  const withdrawn = closedMeta({ state: "cancelled" }, false);
  expect(closedQuestionWords([indent], undefined, withdrawn).outcome).toBe(
    "Withdrawn by the agent",
  );
});
