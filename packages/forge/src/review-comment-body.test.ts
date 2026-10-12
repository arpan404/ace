import { expect, test } from "vitest";
import { authoredReviewComment, hostedReviewCommentEdit, reviewWriteMarker } from "./index.ts";

test("comment editing hides only an exact trailing ace publication marker", () => {
  const marker = reviewWriteMarker("original-publication");
  expect(authoredReviewComment(`Authored\n\n${marker}`)).toBe("Authored");
  for (const body of [
    `Authored\n\n${marker}\n`,
    `Authored\n\n${marker}\nMore text`,
    `Authored ${marker}`,
    "Authored\n\n<!-- ace-write:short -->",
    "Authored\n\n<!-- someone-else:metadata -->",
  ])
    expect(authoredReviewComment(body)).toBe(body);
});

test("editing retains the original publication marker and preserves marker-like authored text", () => {
  const marker = reviewWriteMarker("original-publication");
  const authored = `New text with an embedded ${marker} example`;
  expect(hostedReviewCommentEdit(authored, `Old text\n\n${marker}`)).toBe(
    `${authored}\n\n${marker}`,
  );
  expect(hostedReviewCommentEdit(authored, `Old text\n\n${marker}\n`)).toBe(authored);
  expect(hostedReviewCommentEdit(authored, "Old text without metadata")).toBe(authored);
});
