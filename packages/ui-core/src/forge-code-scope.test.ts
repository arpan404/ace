import { expect, test } from "vitest";
import { codeRange, codeScopeKey, parseCodeScope, sinceLastReview } from "./forge-code-review.ts";

const commits = ["1", "2", "3", "4"].map((n) => ({ sha: n.repeat(40) }));
const [c1, c2, c3, c4] = commits.map((commit) => commit.sha) as [string, string, string, string];

test("Since your review reads the commits after the reviewed head through the head now", () => {
  const since = sinceLastReview(
    { viewer: "me", reviews: [{ login: "Me", commitSha: c2 }] },
    commits,
    c4,
  );
  expect(since?.count).toBe(2);
  expect(codeRange({ kind: "since-review" }, commits, since)).toEqual({ commit: c4, since: c2 });
  // With no review to start from, it reads All commits rather than nothing.
  expect(codeRange({ kind: "since-review" }, commits, undefined)).toEqual({ commit: "" });
});

test("a span of commits reads from the commit before its first through its last", () => {
  expect(codeRange({ kind: "commits", from: c2, to: c3 }, commits, undefined)).toEqual({
    commit: c3,
    since: c1,
  });
  expect(codeRange({ kind: "commits", from: c3, to: c3 }, commits, undefined)).toEqual({
    commit: c3,
  });
  // From the first commit through the head is the whole pull request.
  expect(codeRange({ kind: "commits", from: c1, to: c4 }, commits, undefined)).toEqual({
    commit: "",
  });
});

test("a span naming a commit a force-push removed falls back to All commits", () => {
  expect(codeRange({ kind: "commits", from: "9".repeat(40), to: c3 }, commits, undefined)).toEqual({
    commit: "",
  });
});

test("a choice survives the picker's string value", () => {
  for (const scope of [
    { kind: "all" as const },
    { kind: "since-review" as const },
    { kind: "commits" as const, from: c2, to: c2 },
    { kind: "commits" as const, from: c2, to: c4 },
  ])
    expect(parseCodeScope(codeScopeKey(scope))).toEqual(scope);
});
