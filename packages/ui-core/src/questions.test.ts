import { Question } from "@ace/protocol";
import { expect, test } from "vitest";
import { answeredQuestions, questionOptions, questionOutcome } from "./questions.ts";

test("the suggested answer loses its (Recommended) suffix and is flagged instead", () => {
  const question = Question.parse({
    id: "q",
    text: "How should the sheet recover?",
    multiSelect: false,
    options: [
      { id: "persist", label: "Persist the draft (Recommended)" },
      { id: "block", label: "Block rotation" },
    ],
  });
  expect(questionOptions(question).map((o) => [o.label, o.recommended])).toEqual([
    ["Persist the draft", true],
    ["Block rotation", false],
  ]);
});

const recovery = Question.parse({
  id: "recovery",
  header: "Rotation",
  text: "How should the sheet recover after rotate?",
  allowOther: true,
  options: [
    { id: "persist", label: "Persist the draft in the view model (Recommended)" },
    { id: "lock", label: "Block rotation while the sheet is open" },
    { id: "reset", label: "Re-open the sheet with a fresh state" },
  ],
});

test("an answered question shows the chosen option and keeps the others aside", () => {
  const [answered] = answeredQuestions([recovery], { recovery: ["persist"] });
  expect(answered?.chosen.map((option) => option.label)).toEqual([
    "Persist the draft in the view model",
  ]);
  expect(answered?.others).toHaveLength(2);
  expect(answered?.typed).toEqual([]);
});

test("an answer sent as a label or as free text still reads right", () => {
  const [byLabel] = answeredQuestions([recovery], {
    recovery: ["Block rotation while the sheet is open"],
  });
  expect(byLabel?.chosen.map((option) => option.id)).toEqual(["lock"]);
  const [typed] = answeredQuestions([recovery], { recovery: ["Keep it in the URL"] });
  expect(typed?.typed).toEqual(["Keep it in the URL"]);
  expect(typed?.chosen).toEqual([]);
});

test("a question's outcome distinguishes answered, skipped and closed", () => {
  const request = { kind: "question", questions: [recovery] };
  expect(
    questionOutcome({
      state: "resolved",
      request,
      resolution: { kind: "question", answers: { recovery: ["persist"] } },
    }),
  ).toBe("answered");
  expect(
    questionOutcome({
      state: "resolved",
      request,
      resolution: { kind: "question", answers: {}, dismissed: true },
    }),
  ).toBe("skipped");
  expect(questionOutcome({ state: "expired", request })).toBe("expired");
  expect(questionOutcome({ state: "pending", request })).toBe("pending");
});
