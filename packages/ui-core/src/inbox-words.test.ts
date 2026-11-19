import { expect, test } from "vitest";
import { inboxReasonWords, inboxTarget, inboxTypeWords, inboxWhyWords } from "./inbox-words.ts";

const repository = { host: "github.com", owner: "acme", name: "ace" };

test("notification reasons read as words, and a reason GitHub adds later still reads", () => {
  expect(inboxReasonWords("review_requested")).toBe("Review requested");
  expect(inboxReasonWords("mention")).toBe("Mentioned");
  expect(inboxReasonWords("comment")).toBe("New comments");
  expect(inboxReasonWords("ci_activity")).toBe("CI activity");
  expect(inboxReasonWords("merge_queue_removed")).toBe("Merge queue removed");
});

test("subject types read as words, and an unknown one is split from its name", () => {
  expect(inboxTypeWords("PullRequest")).toBe("Pull request");
  expect(inboxTypeWords("CheckSuite")).toBe("Workflow run");
  expect(inboxTypeWords("SecurityCampaign")).toBe("Security campaign");
});

test("pull requests and issues open in ace; every other subject opens on GitHub", () => {
  expect(inboxTarget({ type: "PullRequest", number: 229, repository })).toEqual({
    kind: "pull",
    number: 229,
  });
  expect(inboxTarget({ type: "Issue", number: 31, repository })).toEqual({
    kind: "issue",
    number: 31,
  });
  expect(
    inboxTarget({ type: "Release", url: "https://github.com/acme/ace/releases", repository }),
  ).toEqual({ kind: "web", url: "https://github.com/acme/ace/releases" });
  expect(inboxTarget({ type: "Discussion", number: 4, repository })).toEqual({
    kind: "web",
    url: "https://github.com/acme/ace",
  });
});

test("a notification's line says why it reached you, not the group it sits in", () => {
  expect(inboxWhyWords({ reason: "review_requested" }, "sam")).toBe("sam asked you to review");
  expect(inboxWhyWords({ reason: "review_requested" })).toBe("You were asked to review");
  expect(inboxWhyWords({ reason: "mention" })).toBe("You were mentioned");
  expect(inboxWhyWords({ reason: "assign" })).toBe("Assigned to you");
  expect(inboxWhyWords({ reason: "state_change", state: "merged" })).toBe("Merged");
  expect(inboxWhyWords({ reason: "state_change", state: "open" })).toBe("Reopened");
  expect(inboxWhyWords({ reason: "brand_new_reason" })).toBe("Brand new reason");
});
