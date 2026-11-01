import { expect, test } from "vitest";
import { threadMatches } from "./thread-match.ts";
import { entry } from "./test-entries.fixture.ts";

test("search matches every word against title, project, branch and pull request", () => {
  const thread = entry("x", { state: "done" }, 0, {
    title: "Persist explorer tree state",
    details: { branch: "ace/persist-explorer", linkedPr: { number: 1536, state: "open" } },
  });
  expect(threadMatches(thread, "explorer", "ace-web")).toBe(true);
  expect(threadMatches(thread, "web tree", "ace-web")).toBe(true);
  expect(threadMatches(thread, "#1536", "ace-web")).toBe(true);
  expect(threadMatches(thread, "persist-explorer", "ace-web")).toBe(true);
  expect(threadMatches(thread, "ios", "ace-web")).toBe(false);
  expect(threadMatches(thread, "  ", "ace-web")).toBe(true);
});
