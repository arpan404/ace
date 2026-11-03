import { describe, expect, it } from "vitest";
import type { ForgeReviewDraft } from "@ace/protocol";
import { submitBlocked, threadCode } from "./forge-review-submit.ts";

const head = "b".repeat(40);
const old = "a".repeat(40);
const draft = (extra: Partial<ForgeReviewDraft> = {}, commit = head): ForgeReviewDraft => ({
  id: "d",
  body: "x",
  anchor: { commit, path: "a.ts", line: 3, side: "RIGHT" },
  ...extra,
});
const base = {
  ready: true,
  writing: false,
  locked: false,
  canComment: true,
  headSha: head,
  stateHead: head,
  drafts: [draft()],
  empty: false,
};

describe("Submit review", () => {
  it("sends when every pending comment is on the head", () => {
    expect(submitBlocked(base)).toBeUndefined();
  });

  it("waits, saying so, while drafts from before a push are being moved", () => {
    expect(submitBlocked({ ...base, drafts: [draft({}, old)] })).toBe(
      "Moving your pending comments to the new commits…",
    );
    expect(submitBlocked({ ...base, stateHead: old })).toMatch(/New commits arrived/);
  });

  it("names the comments a push left behind and what to do with them", () => {
    const outdated = draft({ outdated: { headSha: head, code: [] } }, old);
    expect(submitBlocked({ ...base, drafts: [outdated, outdated, draft()] })).toBe(
      "New commits changed the lines of 2 comments. Post them on their files or remove them to submit.",
    );
  });

  it("says why when a review is already pending on GitHub, or nothing would be sent", () => {
    expect(submitBlocked({ ...base, hostedPending: { id: "R", comments: 1 } })).toMatch(
      /review pending on GitHub with 1 comment\./,
    );
    expect(submitBlocked({ ...base, drafts: [], empty: true })).toBe(
      "Write a summary, add a line comment, or approve.",
    );
  });
});

describe("code above a thread", () => {
  const hunk = "@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n d";
  it("keeps the last lines and marks the ones the thread is on", () => {
    const rows = threadCode({ hunk, side: "RIGHT", originalLine: 3, originalStartLine: 2 }, 3);
    expect(rows.map((r) => [r.text, r.commented])).toEqual([
      ["B", true],
      ["c", true],
      ["d", false],
    ]);
  });
  it("marks the hunk's last line when GitHub gave no line, and is empty without a hunk", () => {
    expect(threadCode({ hunk }, 2).map((r) => r.commented)).toEqual([false, true]);
    expect(threadCode({}, 4)).toEqual([]);
  });
});
