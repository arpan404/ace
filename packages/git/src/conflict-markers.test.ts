import { expect, test } from "vitest";
import { hasConflictHunks, parseConflictMarkers } from "./conflict-markers.ts";

const diff3 = [
  "before\n",
  "<<<<<<< HEAD\n",
  "ours line\n",
  "||||||| base\n",
  "base line\n",
  "=======\n",
  "theirs line\n",
  ">>>>>>> origin/main\n",
  "after\n",
].join("");

test("a diff3 hunk splits into ours, base and theirs between the plain text around it", () => {
  expect(parseConflictMarkers(diff3)).toEqual([
    { kind: "text", text: "before\n" },
    {
      kind: "conflict",
      ours: "ours line\n",
      base: "base line\n",
      theirs: "theirs line\n",
      markers: {
        ours: "<<<<<<< HEAD\n",
        base: "||||||| base\n",
        separator: "=======\n",
        theirs: ">>>>>>> origin/main\n",
      },
    },
    { kind: "text", text: "after\n" },
  ]);
});

test("a hunk without a base section has a null base", () => {
  const [hunk] = parseConflictMarkers("<<<<<<< a\nx\n=======\ny\n>>>>>>> b");
  expect(hunk).toMatchObject({ kind: "conflict", ours: "x\n", base: null, theirs: "y\n" });
});

test("joining every segment gives the file back, CRLF endings included", () => {
  const text = diff3.replaceAll("\n", "\r\n");
  const joined = parseConflictMarkers(text)
    .map((segment) =>
      segment.kind === "text"
        ? segment.text
        : segment.markers.ours +
          segment.ours +
          (segment.markers.base ?? "") +
          (segment.base ?? "") +
          segment.markers.separator +
          segment.theirs +
          segment.markers.theirs,
    )
    .join("");
  expect(joined).toBe(text);
});

test("marker-like lines that open no complete hunk stay text", () => {
  const markdown = "Title\n=======\n<<<<<<< not closed\nstill text\n";
  expect(parseConflictMarkers(markdown)).toEqual([{ kind: "text", text: markdown }]);
  expect(hasConflictHunks(markdown)).toBe(false);
  expect(hasConflictHunks(diff3)).toBe(true);
});
