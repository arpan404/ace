import { expect, test } from "vitest";
import type { ThreadListEntry, ThreadStatus } from "@ace/protocol";
import { isChatEntry } from "./chat-list.ts";
import { placeAttention, placeSignals } from "./place-signals.ts";
import { placeReader } from "./thread-place.ts";
import { standingReader } from "./thread-standing.ts";
import { entry } from "./test-entries.fixture.ts";

const now = new Date(2026, 9, 31, 15).getTime();
const minute = 60_000;
const day = 24 * 60 * minute;

const chat = (
  id: string,
  extra: Record<string, unknown> = {},
  status: ThreadStatus = { state: "done" },
) =>
  entry(id, status, now - minute, {
    workspaceId: `chat-${id}`,
    details: { workspace: { id: `chat-${id}`, name: "Chat", path: `/chats/${id}`, kind: "chat" } },
    ...extra,
  });

function dots(entries: readonly ThreadListEntry[]) {
  const input = { baseline: 0, now };
  return placeSignals(
    placeAttention({
      entries,
      isChat: isChatEntry,
      place: placeReader({ fallback: input }),
      standing: standingReader(input),
    }),
  );
}

test("each rail place's dot comes from its own threads", () => {
  const signals = dots([
    chat("asks", {}, { state: "needs_you", interactions: 1 }),
    entry("finished", { state: "done" }, now - minute),
    entry("read", { state: "done" }, now - minute, { readAt: now }),
  ]);
  expect(signals.chats).toEqual({ tone: "needs-you", needsYou: 1 });
  expect(signals.threads).toEqual({ tone: "unread", needsYou: 0 });
});

test("reading every listed chat clears the Chats dot", () => {
  const unread = [chat("a"), chat("b", {}, { state: "failed" })];
  expect(dots(unread).chats.tone).toBe("unread");
  // Opening a chat records when it was read on the daemon (`thread.read`), for every device.
  const read = unread.map((each) => ({ ...each, readAt: now }));
  expect(dots(read).chats).toEqual({ tone: undefined, needsYou: 0 });
});

test("a settled, snoozed, archived or delegated chat never lights the Chats dot", () => {
  const signals = dots([
    // Finished unread, then settled before anyone opened it: Settled draws it quiet.
    chat("settled", { settledAt: now - day, settledReason: "manual" }),
    chat("auto", { settledAt: now - day, settledReason: "inactivity" }),
    chat("snoozed", { snoozedUntil: now + day }),
    chat("archived", { archivedAt: now - day }),
    chat("delegated", {
      hasSentMessage: true,
      delegatedFrom: { hostId: "host-a", threadId: "parent-on-a" },
    }),
  ]);
  expect(signals.chats).toEqual({ tone: undefined, needsYou: 0 });
});

test("a settled chat that comes to need the person lights the dot, as it returns to its list", () => {
  const signals = dots([
    chat(
      "asks",
      { settledAt: now - day, settledReason: "manual" },
      {
        state: "needs_you",
        interactions: 1,
      },
    ),
  ]);
  expect(signals.chats).toEqual({ tone: "needs-you", needsYou: 1 });
});

test("a paired machine's child asking for approval never lights this machine's Threads dot", () => {
  const signals = dots([
    entry("delegated", { state: "needs_you", interactions: 1 }, now - minute, {
      hasSentMessage: true,
      delegatedFrom: { hostId: "host-a", threadId: "parent-on-a" },
    }),
    entry("finished", { state: "done" }, now - minute, {
      delegatedFrom: { hostId: "host-a", threadId: "parent-on-a" },
    }),
  ]);
  expect(signals.threads).toEqual({ tone: undefined, needsYou: 0 });
});
