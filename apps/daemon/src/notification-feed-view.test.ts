import { describe, expect, it } from "vitest";
import { Notification, ThreadId } from "@ace/protocol";
import type { InboxFeed } from "@ace/notify";
import { capLinked, memberFeed, visibleFeed } from "./notification-feed-view.ts";

const shared = ThreadId.parse("t_shared");
const hidden = ThreadId.parse("t_hidden");
const alert = (id: string, threadId: ThreadId, threadIds?: ThreadId[]) =>
  Notification.parse({
    id,
    threadId,
    title: "Done",
    status: threadIds ? "catch_up" : "done",
    backgroundCount: 0,
    actions: [],
    ...(threadIds ? { threadIds } : {}),
  });
const feed: InboxFeed = {
  cursor: 9,
  seen: 5,
  entries: [
    { cursor: 3, notification: alert("a", shared) },
    { cursor: 5, notification: alert("b", hidden) },
  ],
  retracted: [
    { id: "c", threadId: hidden },
    { id: "d", threadId: shared },
  ],
};

describe("a catch-up feed as one socket may read it", () => {
  it("keeps only the entries and retractions of trees the socket may read", () => {
    expect(visibleFeed(feed, (thread) => thread === shared)).toEqual({
      cursor: 9,
      entries: [{ cursor: 3, notification: alert("a", shared) }],
      retracted: ["d"],
    });
  });

  it("gives a socket that reads everything the whole feed", () => {
    const all = visibleFeed(feed, () => true);
    expect(all.entries.map((entry) => entry.notification.id)).toEqual(["a", "b"]);
    expect(all.retracted).toEqual(["c", "d"]);
  });

  it("drops a summary that names any thread the socket may not read", () => {
    const summary = {
      ...feed,
      entries: [{ cursor: 4, notification: alert("s", shared, [shared, hidden]) }],
    };
    expect(visibleFeed(summary, (thread) => thread === shared).entries).toEqual([]);
    expect(visibleFeed(summary, () => true).entries).toHaveLength(1);
  });

  it("still moves the cursor past alerts the socket may not read", () => {
    expect(visibleFeed(feed, () => false)).toEqual({ cursor: 9, entries: [], retracted: [] });
  });
});

describe("a member's feed on an organization's host", () => {
  it("never reports a cursor beyond what the member's own device holds", () => {
    expect(visibleFeed(feed, () => true).cursor).toBe(9);
    expect(memberFeed(feed, () => true).cursor).toBe(5);
    expect(memberFeed({ ...feed, entries: [], seen: 2 }, () => false).cursor).toBe(2);
  });

  it("keeps the same filtered entries as any socket's feed", () => {
    expect(memberFeed(feed, (thread) => thread === shared)).toEqual({
      cursor: 5,
      entries: [{ cursor: 3, notification: alert("a", shared) }],
      retracted: ["d"],
    });
  });
});

describe("the linked ids handed to the worker", () => {
  it("keeps the first ones and counts what was cut", () => {
    expect(capLinked(["a", "b", "c"], 2)).toEqual({ ids: ["a", "b"], cut: 1 });
    expect(capLinked(["a"], 2)).toEqual({ ids: ["a"], cut: 0 });
  });
});
