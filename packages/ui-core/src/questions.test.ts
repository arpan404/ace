import { Question } from "@ace/protocol";
import { expect, test } from "vitest";
import { questionOptions } from "./questions.ts";

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
