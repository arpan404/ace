import { describe, expect, test } from "vitest";
import {
  inboxQueryText,
  inboxSearchOf,
  issueQueryText,
  issueSearchOf,
  prQueryText,
  prSearchOf,
} from "./query-text.ts";

describe("the pull request search line", () => {
  test("an unfiltered list reads as open pull requests", () => {
    expect(prQueryText({})).toBe("is:pr is:open");
    expect(prSearchOf("is:pr is:open")).toMatchObject({ state: undefined, q: undefined });
  });

  test("every filter survives the trip through the line", () => {
    const search = {
      state: "merged",
      who: "reviewing",
      author: "sam",
      labels: ["bug", "good first issue"],
      review: "changes",
      checks: "failing",
      draft: "hide",
      q: "worker",
    } as const;
    const line = prQueryText(search);
    expect(line).toBe(
      'is:pr is:merged draft:false review-requested:@me author:sam label:bug label:"good first issue" review:changes_requested status:failure worker',
    );
    expect(prSearchOf(line)).toEqual({ ...search, labels: [...search.labels] });
  });

  test("a line without a state shows every state, and leaving a filter out clears it", () => {
    expect(prSearchOf("is:pr label:bug")).toMatchObject({
      state: "all",
      labels: ["bug"],
      author: undefined,
      review: undefined,
    });
  });

  test("words no qualifier knows stay as the free-text search", () => {
    expect(prSearchOf("is:pr is:open milestone:v2 reconnect worker").q).toBe(
      "milestone:v2 reconnect worker",
    );
  });
});

describe("the issue search line", () => {
  test("assigned and created read as GitHub's @me qualifiers, and back", () => {
    expect(issueQueryText({ who: "assigned", state: "closed" })).toBe(
      "is:issue is:closed assignee:@me",
    );
    expect(issueSearchOf("is:issue is:closed author:@me label:web")).toMatchObject({
      state: "closed",
      who: "created",
      labels: ["web"],
      q: undefined,
    });
  });

  test("issues stay open unless the line says closed", () => {
    expect(issueSearchOf("scroll position")).toMatchObject({ state: undefined, q: "scroll position" });
  });
});

describe("the inbox filter line", () => {
  test("unread is the default, and a repository keeps the host the inbox saw", () => {
    expect(inboxQueryText({ reason: "mention", repo: "github.com/acme/docs-site" })).toBe(
      "is:unread reason:mention repo:acme/docs-site",
    );
    expect(
      inboxSearchOf("is:unread reason:team-mention repo:acme/ace", ["ghe.acme.dev/acme/ace"]),
    ).toEqual({
      view: undefined,
      only: undefined,
      reason: "team_mention",
      repo: "ghe.acme.dev/acme/ace",
    });
  });

  test("without is:unread, read notifications show too", () => {
    expect(inboxSearchOf("is:participating", [])).toMatchObject({
      view: "all",
      only: "participating",
    });
  });
});
