import { expect, test } from "vitest";
import { prTimeline, eventText } from "./pr-timeline.ts";
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
