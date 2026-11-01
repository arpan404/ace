import { expect, test } from "vitest";
import type { ThreadListEntry, ThreadStatus } from "@ace/protocol";
import { chatList, chatRows, isChatEntry, placeSignals, withChatHits } from "./chat-list.ts";
import { standingReader } from "./home-tree.ts";
import { entry } from "./test-entries.fixture.ts";

const local = (month: number, date: number, hour = 12) =>
  new Date(2026, month - 1, date, hour).getTime();
// Saturday 31 October 2026, mid-afternoon.
const now = local(10, 31, 15);
const minute = 60_000;

const chatDetails = (id: string) => ({
  workspaceId: id,
  details: { workspace: { id, name: "Chat", path: `/chats/${id}`, kind: "chat" } },
});
const chat = (
  id: string,
  at: number,
  extra: Record<string, unknown> = {},
  status: ThreadStatus = { state: "done" },
) => entry(id, status, at, { readAt: at, ...chatDetails(`chat-${id}`), ...extra });

function rows(entries: readonly ThreadListEntry[]) {
  return chatRows(
    chatList({ entries, isChat: isChatEntry, standing: standingReader({ baseline: 0, now }), now }),
  );
}

test("chats group by the day they last moved, newest first, and project threads stay out", () => {
  const drawn = rows([
    chat("old", local(9, 2)),
    chat("this-morning", local(10, 31, 8)),
    chat("last-night", local(10, 30, 23)),
    chat("tuesday", local(10, 27)),
    entry("project-work", { state: "done" }, now - minute, { readAt: now }),
    chat("just-now", now - minute),
  ]);
  expect(drawn).toEqual([
    { kind: "day-label", day: "today" },
    { kind: "chat", id: "just-now", settled: false },
    { kind: "chat", id: "this-morning", settled: false },
    { kind: "day-label", day: "yesterday" },
    { kind: "chat", id: "last-night", settled: false },
    { kind: "day-label", day: "week" },
    { kind: "chat", id: "tuesday", settled: false },
    { kind: "day-label", day: "earlier" },
    { kind: "chat", id: "old", settled: false },
  ]);
});

test("pinned chats lead under Pinned and leave their day", () => {
  const drawn = rows([
    chat("today", now - minute),
    chat("pinned-old", local(8, 1), { pinned: true }),
  ]);
  expect(drawn).toEqual([
    { kind: "pinned-label" },
    { kind: "chat", id: "pinned-old", settled: false },
    { kind: "day-label", day: "today" },
    { kind: "chat", id: "today", settled: false },
  ]);
});

test("a settled chat stays in its day, dimmed, while one whose subagent still works is not", () => {
  const drawn = rows([
    chat("rested", now - 2 * minute, { settledAt: now - minute }),
    chat("busy", now - 3 * minute, {
      settledAt: now - minute,
      live: { runningSubagentCount: 1 },
    }),
  ]);
  expect(drawn).toEqual([
    { kind: "day-label", day: "today" },
    { kind: "chat", id: "rested", settled: true },
    { kind: "chat", id: "busy", settled: false },
  ]);
});

test("archived chats, empty drafts and a chat mid-move to a project are not listed", () => {
  // Moved to a project, not yet confirmed: the old details still name the chat's project.
  const moving = entry("moving", { state: "done" }, now - minute, {
    readAt: now,
    details: chatDetails("chat-moving").details,
  });
  const drawn = rows([
    chat("archived", now - minute, { archivedAt: now }),
    entry("draft", { state: "new" }, now, { hasSentMessage: false, ...chatDetails("chat-draft") }),
    moving,
    chat("kept", now - minute),
  ]);
  expect(drawn).toEqual([
    { kind: "day-label", day: "today" },
    { kind: "chat", id: "kept", settled: false },
  ]);
});

test("an older chat a search found joins its day as settled; one already listed keeps its place", () => {
  const list = chatList({
    entries: [chat("today", now - minute)],
    isChat: isChatEntry,
    standing: standingReader({ baseline: 0, now }),
    now,
  });
  const found = withChatHits(
    list,
    [
      { id: "today", at: local(1, 5) },
      { id: "january", at: local(1, 5) },
    ],
    now,
  );
  expect(chatRows(found)).toEqual([
    { kind: "day-label", day: "today" },
    { kind: "chat", id: "today", settled: false },
    { kind: "day-label", day: "earlier" },
    { kind: "chat", id: "january", settled: true },
  ]);
});

test("each rail place's dot comes from its own threads", () => {
  const signals = placeSignals({
    entries: [
      chat("asks", now - minute, {}, { state: "needs_you", interactions: 1 }),
      entry("finished", { state: "done" }, now - minute),
      entry("read", { state: "done" }, now - minute, { readAt: now }),
    ],
    isChat: isChatEntry,
    standing: standingReader({ baseline: 0, now }),
  });
  expect(signals.chats).toEqual({ tone: "needs-you", needsYou: 1 });
  expect(signals.threads).toEqual({ tone: "unread", needsYou: 0 });
});
