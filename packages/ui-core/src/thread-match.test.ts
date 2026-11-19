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

test("search forgives a typo, a swap or an abbreviation, but not a different word", () => {
  const thread = entry("x", { state: "done" }, 0, {
    title: "Add pagination to the sidebar",
    details: { branch: "fix/settled-paging" },
  });
  const finds = (query: string) => threadMatches(thread, query, "relay");
  // One letter dropped, added, changed or two swapped.
  expect(finds("paginaton")).toBe(true);
  expect(finds("paginnation")).toBe(true);
  expect(finds("sidebor")).toBe(true);
  expect(finds("sidbear")).toBe(true);
  // A word still being typed, with a typo in it.
  expect(finds("pagni")).toBe(true);
  // Letters in order from the word's first letter.
  expect(finds("pgntn")).toBe(true);
  expect(finds("stld")).toBe(true);
  // Every word must still match somewhere.
  expect(finds("pagination ios")).toBe(false);
  // Short words must be exact, and a word two typos away doesn't match.
  expect(finds("pz")).toBe(false);
  expect(finds("pagimaton")).toBe(false);
  // An abbreviation starts where the word does.
  expect(finds("pgn")).toBe(true);
  expect(finds("gntn")).toBe(false);
});
