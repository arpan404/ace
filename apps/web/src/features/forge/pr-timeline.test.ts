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
    "event:6",
    "comment:issue:4",
    `commit:${commit.sha}`,
    "opened",
  ]);
  expect(prTimeline(detail, [commit], events, "oldest").map((row) => row.id)).toEqual([
    "opened",
    `commit:${commit.sha}`,
    "comment:issue:4",
    "event:6",
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
  expect(prTimeline(detail, [], [event], "newest").at(-1)?.id).toBe("event:future");
  expect(prTimeline(detail, [], [event], "oldest").at(-1)?.id).toBe("event:future");
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
