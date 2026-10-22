import { expect, test } from "vitest";
import { prTimeline, prTimelineItems, eventText } from "./pr-timeline.ts";
import { detail } from "./pr-workspace.fixture.ts";
const commit = {
  sha: "a".repeat(40),
  message: "Fix cursor",
  author: "octo",
  date: "2026-10-11T12:01:00Z",
  url: "https://github.com/acme/ace/commit/aaa",
};
const events = [
  { id: "4", event: "commented", actor: "reviewer", at: "2026-10-11T12:02:00Z", raw: {} },
  { id: "5", event: "committed", actor: "octo", at: commit.date, commitSha: commit.sha, raw: {} },
  {
    id: "6",
    event: "labeled",
    actor: "maintainer",
    at: "2026-10-11T12:03:00Z",
    subject: "bug",
    raw: {},
  },
];
test("timeline interleaves commits, comments and events by creation time without duplicating REST echoes", () => {
  expect(prTimeline(detail, [commit], events, "newest").map((row) => row.id)).toEqual([
    "event:labeled:6",
    "comment:issue:4",
    `commit:${commit.sha}`,
    "opened",
  ]);
  expect(prTimeline(detail, [commit], events, "oldest").map((row) => row.id)).toEqual([
    "opened",
    `commit:${commit.sha}`,
    "comment:issue:4",
    "event:labeled:6",
  ]);
});
test("unknown undated provider activity remains visible after dated entries in either sort order", () => {
  const event = {
    id: "future",
    event: "provider_future_event",
    actor: "octo",
    at: null,
    raw: { future: 1 },
  };
  expect(prTimeline(detail, [], [event], "newest").at(-1)?.id).toBe(
    "event:provider_future_event:future",
  );
  expect(prTimeline(detail, [], [event], "oldest").at(-1)?.id).toBe(
    "event:provider_future_event:future",
  );
  expect(eventText(event)).toBe("provider future event");
  expect(
    eventText({
      id: "6",
      event: "labeled",
      actor: "maintainer",
      at: null,
      subject: "bug",
      raw: {},
    }),
  ).toBe("added label bug");
});

test("numeric IDs shared by inline comments, issue comments and reviews do not hide other kinds of timeline activity", () => {
  const source = detail.status.comments[0];
  if (!source) throw new Error("Missing comment fixture");
  const value = {
    ...detail,
    status: {
      ...detail.status,
      comments: [{ ...source, kind: "inline" as const, file: "src/page.ts", line: 1 }],
    },
  };
  const activity = [
    {
      id: "4",
      event: "reviewed",
      actor: "reviewer",
      at: source.createdAt ?? source.updatedAt,
      raw: {},
    },
    { id: "4", event: "commented", actor: "author", at: source.updatedAt, raw: {} },
  ];
  const rows = prTimeline(value, [], activity, "newest");
  expect(rows.filter((row) => row.kind === "event").map((row) => row.event.event)).toContain(
    "reviewed",
  );
  expect(rows.filter((row) => row.kind === "event").map((row) => row.event.event)).toContain(
    "commented",
  );
  const withReview = {
    ...value,
    status: {
      ...value.status,
      comments: [
        ...value.status.comments,
        { ...source, kind: "review" as const, reviewState: "APPROVED" },
      ],
    },
  };
  const deduplicated = prTimeline(withReview, [], activity, "newest");
  expect(
    deduplicated.filter((row) => row.kind === "event").map((row) => row.event.event),
  ).not.toContain("reviewed");
  expect(
    deduplicated.filter((row) => row.kind === "event").map((row) => row.event.event),
  ).toContain("commented");
});

const at = (minute: number) => new Date(Date.UTC(2026, 9, 11, 12, minute)).toISOString();
type Comment = (typeof detail.status.comments)[number];
const withComments = (comments: (Partial<Comment> & Pick<Comment, "id">)[]) => ({
  ...detail,
  status: {
    ...detail.status,
    comments: comments.map((comment): Comment => ({
      kind: "issue",
      body: "Looks fine",
      author: "reviewer",
      file: null,
      line: null,
      replyTo: null,
      updatedAt: comment.createdAt ?? at(0),
      ...comment,
    })),
  },
});
const crossReference = (id: string, minute: number, number: number, pullRequest: boolean) => ({
  id,
  event: "cross-referenced",
  actor: "octo",
  at: at(minute),
  raw: {
    event: "cross-referenced",
    source: {
      issue: {
        number,
        title: `Item ${number}`,
        html_url: `https://github.com/acme/ace/issues/${number}`,
        ...(pullRequest ? { pull_request: { url: "x" } } : {}),
      },
    },
  },
});

test("consecutive references collapse into one row listing each linked item, split by other activity", () => {
  const history = [
    crossReference("r1", 5, 901, true),
    {
      id: "r2",
      event: "referenced",
      actor: "octo",
      at: at(6),
      commitSha: "c".repeat(40),
      raw: { commit_id: "c".repeat(40) },
    },
    crossReference("r3", 7, 42, false),
    { id: "l1", event: "labeled", actor: "octo", at: at(8), subject: "bug", raw: {} },
    crossReference("r4", 9, 77, true),
    { id: "r5", event: "cross-referenced", actor: "octo", at: at(10), raw: { source: "odd" } },
  ];
  const groups = prTimelineItems(detail, [], history, "oldest").flatMap((item) =>
    item.kind === "references" ? [item] : [],
  );
  expect(groups.map((group) => group.references.map((reference) => reference.target))).toEqual([
    [
      {
        kind: "item",
        number: 901,
        title: "Item 901",
        url: "https://github.com/acme/ace/issues/901",
        pullRequest: true,
      },
      { kind: "commit", sha: "c".repeat(40) },
      {
        kind: "item",
        number: 42,
        title: "Item 42",
        url: "https://github.com/acme/ace/issues/42",
        pullRequest: false,
      },
    ],
    [expect.objectContaining({ number: 77, pullRequest: true }), null],
  ]);
  expect(groups[0]?.at).toBe(at(7));
});

test("a close recorded with the merge folds into the merged row, while an earlier close stays", () => {
  const history = [
    { id: "c1", event: "closed", actor: "octo", at: at(5), raw: {} },
    { id: "o1", event: "reopened", actor: "octo", at: at(6), raw: {} },
    { id: "c2", event: "closed", actor: "octo", at: at(30), raw: {} },
    { id: "m1", event: "merged", actor: "octo", at: at(30), raw: {} },
    { id: "d1", event: "head_ref_deleted", actor: "octo", at: at(31), raw: {} },
  ];
  const rows = prTimelineItems(detail, [], history, "oldest");
  expect(rows.flatMap((row) => (row.kind === "lifecycle" ? [row.state] : []))).toEqual([
    "opened",
    "closed",
    "reopened",
    "merged",
  ]);
  expect(rows.at(-1)?.kind).toBe("event");
});

test("reviews carry a verdict and go stale when superseded, dismissed or given on an older commit", () => {
  const value = withComments([
    { kind: "review", id: 1, author: "ana", reviewState: "APPROVED", createdAt: at(1) },
    { kind: "review", id: 2, author: "ana", reviewState: "CHANGES_REQUESTED", createdAt: at(2) },
    { kind: "review", id: 3, author: "bo", reviewState: "APPROVED", createdAt: at(3) },
    { kind: "review", id: 4, author: "cy", reviewState: "DISMISSED", createdAt: at(4) },
    { kind: "review", id: 5, author: "di", reviewState: "COMMENTED", createdAt: at(5) },
  ]);
  const history = [
    { id: "3", event: "reviewed", actor: "bo", at: at(3), raw: { commit_id: "d".repeat(40) } },
    { id: "5", event: "reviewed", actor: "di", at: at(5), raw: { commit_id: "a".repeat(40) } },
  ];
  const reviews = prTimelineItems(value, [], history, "oldest").flatMap((row) =>
    row.kind === "review" ? [[row.comment.id, row.verdict, row.stale]] : [],
  );
  expect(reviews).toEqual([
    [1, "approved", true],
    [2, "changes", false],
    [3, "approved", true],
    [4, "dismissed", true],
    [5, "commented", false],
  ]);
});

test("three or more comments close together fold into one burst; sparse or short runs stay separate", () => {
  const value = withComments([
    { id: 1, author: "ana", createdAt: at(1) },
    { id: 2, author: "bo", createdAt: at(20) },
    { id: 3, author: "ana", createdAt: at(50) },
    { id: 4, author: "cy", createdAt: at(200) },
    { id: 5, author: "cy", createdAt: at(210) },
  ]);
  const rows = prTimelineItems(value, [], [], "oldest").filter((row) => row.kind !== "lifecycle");
  expect(
    rows.map((row) =>
      row.kind === "comments"
        ? { burst: row.comments.map((comment) => comment.id), authors: row.authors, at: row.at }
        : row.id,
    ),
  ).toEqual([
    { burst: [1, 2, 3], authors: ["ana", "bo"], at: at(50) },
    "comment:issue:4",
    "comment:issue:5",
  ]);
});

test("newest-first lists the same groups in reverse order, keeping their identities", () => {
  const value = withComments([
    { id: 1, createdAt: at(2) },
    { id: 2, createdAt: at(3) },
    { id: 3, createdAt: at(4) },
  ]);
  const history = [crossReference("r1", 10, 5, true), crossReference("r2", 11, 6, false)];
  const oldest = prTimelineItems(value, [commit], history, "oldest").map((row) => row.id);
  const newest = prTimelineItems(value, [commit], history, "newest").map((row) => row.id);
  expect(oldest).toEqual([
    "opened",
    `commit:${commit.sha}`,
    "comments:comment:issue:1",
    "references:r1",
  ]);
  expect(newest).toEqual(oldest.toReversed());
});

const said = (name: string, subject?: string) =>
  eventText({
    id: name,
    event: name,
    actor: "octo",
    at: null,
    raw: {},
    ...(subject ? { subject } : {}),
  });

test("branch, lock and milestone events read as what happened, with the lock's reason", () => {
  expect(said("locked", "too heated")).toBe("locked the conversation as too heated");
  expect(said("locked")).toBe("locked the conversation");
  expect(said("head_ref_restored")).toBe("restored the branch");
  expect(said("milestoned", "October polish")).toBe("added this to the milestone October polish");
  expect(said("connected")).toBe("linked an issue");
});
