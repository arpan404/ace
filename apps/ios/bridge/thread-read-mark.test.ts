import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { commands, connect, fixture, latest, open, reset, until } from "./thread-harness.ts";
import { ReadMark, readDwellMs } from "./thread-read-mark.ts";

/*
 * Reading a finished thread to its last answer marks it read from the phone, as the desktop
 * does, so the row's check goes. Leaving before the end keeps it. The rule runs on a clock the
 * tests turn; one test follows it over the real SDK and the fake daemon.
 */

afterEach(reset);

/** A reader on a clock the test turns, with what it sent the daemon. */
function reader(start: { cursor?: number; unread?: boolean | undefined } = {}) {
  const state = {
    cursor: start.cursor ?? 10,
    unread: "unread" in start ? start.unread : false,
    now: 0,
  };
  const timers = new Set<{ at: number; run: () => void }>();
  const sent: string[] = [];
  const mark = new ReadMark({
    cursor: () => state.cursor,
    markedUnread: () => state.unread,
    markRead: (seq) => sent.push(`markRead ${seq}`),
    clearUnread: () => {
      state.unread = false;
      sent.push("read");
    },
    schedule: (ms, run) => {
      const timer = { at: state.now + ms, run };
      timers.add(timer);
      return () => timers.delete(timer);
    },
  });
  const wait = (ms: number) => {
    state.now += ms;
    for (const timer of timers)
      if (timer.at <= state.now) {
        timers.delete(timer);
        timer.run();
      }
  };
  return { mark, state, sent, wait };
}

test("staying at the last answer marks the thread read through it, once", () => {
  const { mark, sent, wait } = reader({ cursor: 42 });
  mark.atEnd(true);
  wait(readDwellMs - 1);
  expect(sent).toEqual([]);
  wait(1);
  expect(sent).toEqual(["markRead 42"]);
  mark.moved();
  wait(readDwellMs);
  expect(sent).toEqual(["markRead 42"]);
});

test("a thread left before its last answer stays unread", () => {
  const { mark, sent, wait } = reader();
  mark.atEnd(true);
  wait(readDwellMs / 2);
  mark.atEnd(false);
  wait(readDwellMs * 2);
  mark.moved();
  expect(sent).toEqual([]);
});

test("an answer arriving while the reader stays at the end is read too", () => {
  const { mark, state, sent, wait } = reader({ cursor: 10 });
  mark.atEnd(true);
  wait(readDwellMs);
  state.cursor = 14;
  mark.moved();
  expect(sent).toEqual(["markRead 10", "markRead 14"]);
});

test("an answer arriving after the reader scrolled up stays unread until they come back", () => {
  const { mark, state, sent, wait } = reader({ cursor: 10 });
  mark.atEnd(true);
  wait(readDwellMs);
  mark.atEnd(false);
  state.cursor = 14;
  mark.moved();
  expect(sent).toEqual(["markRead 10"]);
  mark.atEnd(true);
  wait(readDwellMs);
  expect(sent).toEqual(["markRead 10", "markRead 14"]);
});

test("a thread marked unread by hand is read again when this visit reaches its end", () => {
  const { mark, sent, wait } = reader({ cursor: 10, unread: true });
  wait(readDwellMs * 2);
  expect(sent).toEqual([]);
  mark.atEnd(true);
  wait(readDwellMs);
  expect(sent).toEqual(["read", "markRead 10"]);
});

test("a thread marked unread by hand whose inbox entry arrives after the dwell is read when it arrives", () => {
  const { mark, state, sent, wait } = reader({ cursor: 10, unread: undefined });
  mark.atEnd(true);
  wait(readDwellMs);
  expect(sent).toEqual(["markRead 10"]);
  state.unread = true;
  mark.listed();
  expect(sent).toEqual(["markRead 10", "read"]);
  // The visit's chance is spent: a Mark unread chosen now stands.
  state.unread = true;
  mark.listed();
  expect(sent).toEqual(["markRead 10", "read"]);
});

test("an inbox entry that arrives after the reader left the end waits for the next arrival there", () => {
  const { mark, state, sent, wait } = reader({ cursor: 10, unread: undefined });
  mark.atEnd(true);
  wait(readDwellMs);
  mark.atEnd(false);
  state.unread = true;
  mark.listed();
  expect(sent).toEqual(["markRead 10"]);
  mark.atEnd(true);
  wait(readDwellMs);
  expect(sent).toEqual(["markRead 10", "read"]);
});

test("Mark unread chosen while reading stands until the thread is opened again", () => {
  const { mark, state, sent, wait } = reader({ cursor: 10 });
  mark.atEnd(true);
  wait(readDwellMs);
  state.unread = true;
  mark.atEnd(false);
  mark.atEnd(true);
  wait(readDwellMs);
  expect(sent).toEqual(["markRead 10"]);
  // The next visit is a new reader.
  mark.dispose();
  const next = reader({ cursor: 10, unread: true });
  next.mark.atEnd(true);
  next.wait(readDwellMs);
  expect(next.sent).toEqual(["read", "markRead 10"]);
});

test("the open thread reached at its end sends thread.markRead through its newest event", async () => {
  const fake = fixture();
  fake.createThread({ id: "done", workspaceId: "ace", title: "Done", provider: "codex" });
  fake.apply("done", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "answer", "assistant", "Fixed the login bug."),
    facts.endTurn("root"),
  ]);
  const client = connect(fake);
  const session = open(client, "done");
  await until(() => latest("thread.ready"), "the thread");
  const held = client.thread("done");
  const seq = held.store.cursor;
  held.release();
  session.handle({ type: "atEnd", atEnd: true });
  const [mark] = await until(() => {
    const sent = commands("thread.markRead");
    return sent.length > 0 && sent;
  }, "the read mark");
  expect(mark).toMatchObject({ threadId: "done", lastSeenSeq: seq });
});
