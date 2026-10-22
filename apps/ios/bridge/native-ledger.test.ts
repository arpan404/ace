import { afterEach, expect, test } from "vitest";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import type { ClientCore, Lease, ThreadSource } from "@ace/client";
import { connect, fixture, native, pump, reset, until } from "./thread-harness.ts";
import { followThread } from "./patches.ts";
import { ThreadSession } from "./thread-session.ts";
import { LedgerShelf, NativeLedger, ledgerText } from "./native-ledger.ts";

/*
 * Reopening a thread native kept (`ThreadShelf.swift`) over the real SDK and the fake daemon:
 * the bridge sends only what changed, and native ends up holding what a fresh open would show.
 * `Held` applies frames the way `ClientModel` does: only the open generation's, a reset clears.
 */

class Held {
  epoch = 0;
  rows = new Map<string, unknown>();
  read = 0;
  apply(): Record<string, unknown>[] {
    const frames = native.frames.slice(this.read);
    this.read = native.frames.length;
    for (const frame of frames) {
      if (frame.epoch !== this.epoch) continue;
      const type = String(frame.type);
      if (type === "thread.reset") {
        this.rows.clear();
        continue;
      }
      if (!["thread.item", "thread.block", "thread.interaction"].includes(type)) continue;
      const key = `${type}:${String(frame.id)}`;
      if (frame.row === null) this.rows.delete(key);
      else this.rows.set(key, frame.row);
    }
    return frames.filter((frame) => frame.epoch === this.epoch);
  }
}

let visit: { lease: Lease<ThreadSource>; stop: () => void; session: ThreadSession } | undefined;
const shelf = new LedgerShelf(6, 4 * 1024 * 1024);

/** What `main.ts` does on open: bind the thread's ledger, follow it, start its session. */
async function openVisit(
  client: ClientCore,
  held: Held,
  threadId: string,
  epoch: number,
  warm: boolean,
) {
  leave(epoch);
  held.epoch = epoch;
  const lease = client.thread(threadId);
  const ledger = shelf.open(threadId, warm);
  pump.bind(ledger, epoch);
  const stop = followThread(lease.store, threadId, epoch, pump, ledger);
  visit = { lease, stop, session: new ThreadSession(client, lease.store, threadId, epoch, pump) };
  await until(() => held.apply().length && latestReady(epoch), "the thread to be ready");
  // Let the frames after ready (late session reads) settle.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return native.frames.filter((frame) => frame.epoch === epoch);
}
function latestReady(epoch: number) {
  return native.frames.some((frame) => frame.type === "thread.ready" && frame.epoch === epoch);
}
function leave(epoch: number) {
  pump.bind(undefined, epoch);
  visit?.session.dispose();
  visit?.stop();
  visit?.lease.release();
  visit = undefined;
}

afterEach(async () => {
  leave(0);
  await reset();
});

function seed(fake: FakeDaemon, id: string, turns: number) {
  fake.createThread({ id, workspaceId: "ace", title: id, provider: "codex" });
  fake.apply(id, [facts.rootAgent("codex")]);
  for (let index = 0; index < turns; index++)
    fake.apply(id, [
      facts.turn("root"),
      facts.message("root", `ask-${index}`, "user", `Question ${index}`),
      facts.tool("root", `read-${index}`, {
        kind: "file.read",
        title: `Read file-${index}.ts`,
        detail: { kind: "file.read", path: `file-${index}.ts` },
      }),
      facts.toolDone("root", `read-${index}`),
      facts.message("root", `answer-${index}`, "assistant", `Answer ${index}`),
      facts.endTurn("root"),
    ]);
}

test("reopening a kept thread sends only what changed and leaves native holding what a fresh open shows", async () => {
  const fake = fixture();
  seed(fake, "kept", 8);
  const client = connect(fake);
  const held = new Held();
  const first = await openVisit(client, held, "kept", 1, false);
  expect(first.some((frame) => frame.type === "thread.reset")).toBe(true);
  const firstRows = first.filter((frame) => frame.type === "thread.item").length;
  expect(firstRows).toBeGreaterThan(20);

  leave(2);
  fake.apply("kept", [
    facts.turn("root"),
    facts.message("root", "ask-new", "user", "One more question"),
    facts.message("root", "answer-new", "assistant", "One more answer"),
    facts.endTurn("root"),
  ]);
  const second = await openVisit(client, held, "kept", 3, true);
  // No reset: native's copy stays on screen and only the new turn travels.
  expect(second.some((frame) => frame.type === "thread.reset")).toBe(false);
  const items = second.filter((frame) => frame.type === "thread.item").map((frame) => frame.id);
  expect(items.length).toBeLessThan(firstRows / 4);
  expect(items.length).toBeGreaterThan(0);

  // The kept copy now matches what a fresh open of the same thread shows.
  const fresh = new Held();
  await openVisit(client, fresh, "kept", 4, false);
  expect(new Map([...held.rows].toSorted())).toEqual(new Map([...fresh.rows].toSorted()));
});

test("a warm reopen the bridge no longer remembers resets native before sending the thread", async () => {
  const fake = fixture();
  seed(fake, "first", 2);
  seed(fake, "second", 2);
  const client = connect(fake);
  const small = new LedgerShelf(1, 4 * 1024 * 1024);
  const ledger = small.open("first", false);
  small.open("second", false);
  // Native says it kept "first", but its ledger went: a fresh ledger that native doesn't hold.
  const reopened = small.open("first", true);
  expect(reopened).not.toBe(ledger);
  expect(reopened.held).toBe(false);
  expect(reopened.begin()).toBe(false);
  await client.close();
});

test("a whole-thread pass removes what native holds that the thread no longer has", () => {
  const ledger = new NativeLedger("thread");
  const row = (id: string) => ({
    type: "thread.item",
    id,
    row: { text: id },
    threadId: "thread",
    epoch: 1,
  });
  ledger.delivered("thread:reset", { type: "thread.reset", epoch: 1 }, "");
  for (const id of ["a", "b", "c"])
    ledger.delivered(`thread:item:${id}`, row(id), ledgerText(row(id)));
  expect(ledger.begin()).toBe(true);
  ledger.touch("thread:item:a");
  ledger.touch("thread:item:c");
  const removals = ledger.close(2);
  expect(removals.map(([key]) => key)).toEqual(["thread:item:b"]);
  expect(removals[0]?.[1]()).toEqual({
    type: "thread.item",
    id: "b",
    row: null,
    threadId: "thread",
    epoch: 2,
  });
});

test("a position moved apart from its row makes the row travel again", () => {
  const ledger = new NativeLedger("thread");
  ledger.hold();
  const row = { type: "thread.item", id: "a", row: { index: 5 }, threadId: "thread", epoch: 1 };
  ledger.delivered("thread:item:a", row, ledgerText(row));
  expect(ledger.same("thread:item:a", ledgerText({ ...row, epoch: 2 }))).toBe(true);
  // Native's position for "a" is now 7: the same row at 5 must be sent to move it back.
  ledger.delivered("thread:position:a", { type: "thread.position", id: "a", index: 7 }, "");
  expect(ledger.same("thread:item:a", ledgerText(row))).toBe(false);
});

test("a visit's steps, lane and attachments are never treated as kept", () => {
  const ledger = new NativeLedger("thread");
  ledger.hold();
  const steps = { type: "thread.steps", ordinal: 1, epoch: 1 };
  ledger.delivered("thread:steps:1", steps, ledgerText(steps));
  expect(ledger.same("thread:steps:1", ledgerText(steps))).toBe(false);
});
