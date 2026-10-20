import { expect, test } from "vitest";
import { permissionResult } from "./input.ts";

const input = { questions: [{ question: "Tabs or Spaces?" }] };

test("a skipped question tells Claude the person's note with the skip", () => {
  expect(
    permissionResult(
      { kind: "question", answers: {}, dismissed: true, feedback: " Use the formatter's default " },
      input,
      [],
    ),
  ).toEqual({
    behavior: "deny",
    message: "The user skipped the question and said: Use the formatter's default",
  });
  expect(permissionResult({ kind: "question", answers: {}, dismissed: true }, input, [])).toEqual({
    behavior: "deny",
    message: "The user dismissed the question.",
  });
});
