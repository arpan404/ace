import { expect, test } from "vitest";
import { withTask } from "./source-marks.ts";

test("a tick changes only the box at its mark, leaving every other character alone", () => {
  const text = "> - [ ] quoted\r\n\r\n1. [x] numbered\r\n2. [ ] last\r\n";
  expect(withTask(text, { offset: text.indexOf("[ ]") + 1, label: "quoted" }, true)).toBe(
    "> - [x] quoted\r\n\r\n1. [x] numbered\r\n2. [ ] last\r\n",
  );
  expect(withTask(text, { offset: text.indexOf("[x]") + 1, label: "numbered" }, false)).toBe(
    "> - [ ] quoted\r\n\r\n1. [ ] numbered\r\n2. [ ] last\r\n",
  );
});

test("an upper-case X counts as ticked and can be cleared", () => {
  expect(withTask("- [X] done", { offset: 3, label: "done" }, false)).toBe("- [ ] done");
});

test("text that no longer holds a box at the drawn place isn't rewritten", () => {
  expect(withTask("- [ ] a", { offset: 1, label: "a" }, true)).toBeUndefined();
  expect(withTask("- [?] a", { offset: 3, label: "a" }, true)).toBeUndefined();
  expect(withTask("- [ ]", { offset: 99, label: "a" }, true)).toBeUndefined();
});
