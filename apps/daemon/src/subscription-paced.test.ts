import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { applyEvent } from "@ace/projection";
import { ServerMessage, type ThreadId, type ThreadView } from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import { message } from "./payload-test-support.ts";
import type { ReplayGate } from "./replay-pacer.ts";
import { Store } from "./store.ts";
import { subscribe } from "./subscription.ts";
import { WireEncoder } from "./wire-encoder.ts";

// A resume's replay delivered in one frame, or paced in n pieces with live events of the same
// and other threads arriving between them and the connection dropping between them, must leave
// the client in exactly the same state.

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-subscription-paced-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"));
  cleanup.push(() => store.close());
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  return { store, a: createDevThread(store, workspace), b: createDevThread(store, workspace) };
}

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

let counter = 0;
/** One random change to `thread`: a new message, a delta to the last, or an update of it. */
function change(store: Store, thread: ThreadId, random: () => number, items: string[]) {
  const last = items.at(-1);
  const choice = random();
  if (!last || choice < 0.4) {
    const id = `${thread}-m${++counter}`;
    items.push(id);
    store.appendEvents(thread, [
      { type: "item.created", item: { ...message(id, "start "), complete: false } },
    ]);
  } else if (choice < 0.8)
    store.appendEvents(thread, [
      {
        type: "item.delta",
        itemId: last as never,
        agentId: "root" as never,
        field: "text",
        append: `w${Math.floor(random() * 1000)} `,
      },
    ]);
  else
    store.appendEvents(thread, [
      { type: "item.updated", item: { ...message(last, `final ${counter}`), complete: true } },
    ]);
}

/** A client of one thread: what it holds, kept by applying what the wire brings. */
class Client {
  view: ThreadView;
  cursor: number;
  constructor(view: ThreadView) {
    this.view = structuredClone(view);
    this.cursor = view.seq;
  }
  apply(sent: ServerMessage) {
    if (sent.type === "snapshot" && sent.view.kind === "thread") {
      this.view = structuredClone(sent.view);
      this.cursor = sent.seq;
    } else if (sent.type === "events") {
      // Contiguous: every message picks up exactly where the last left off.
      expect(sent.afterSeq).toBe(this.cursor);
      // Other threads' events leave gaps in a thread's seqs: the message, not each event, is
      // what must follow on, as the client's thread store reads it.
      for (const event of sent.events) {
        this.view.seq = (event.firstSeq ?? event.seq) - 1;
        expect(applyEvent(this.view, event).kind).toBe("applied");
      }
      this.view.seq = sent.throughSeq;
      this.cursor = sent.throughSeq;
    }
  }
  /** What the person sees: the thread's items in order. */
  state() {
    return { order: this.view.itemOrder, items: this.view.items };
  }
}

/** A gate the test drives: tiny pieces, the next made only when the test says so. */
function testGate() {
  const waiting: (() => void)[] = [];
  const gate: ReplayGate = {
    pieceBytes: () => 300,
    whenReady(next) {
      waiting.push(next);
      return () => {
        const index = waiting.indexOf(next);
        if (index >= 0) waiting.splice(index, 1);
      };
    },
    sent() {},
    forget() {},
  };
  return { gate, waiting };
}

let ids = 0;
function open(
  store: Store,
  thread: ThreadId,
  afterSeq: number | undefined,
  wire: (sent: ServerMessage) => void,
  gate?: ReplayGate,
) {
  const encoder = new WireEncoder();
  const stop = subscribe(
    store,
    `s${++ids}`,
    { kind: "thread", threadId: thread },
    afterSeq,
    5000,
    (sent) => wire(ServerMessage.parse(JSON.parse(encoder.encode(sent)))),
    250,
    () => () => {},
    false,
    encoder,
    undefined,
    undefined,
    undefined,
    gate,
  );
  cleanup.push(stop);
  return stop;
}

it("a replay in one frame and in paced pieces, with live events and drops between, gives the same client", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const random = seeded(seed);
    const { store, a, b } = setup();
    const itemsA: string[] = [];
    const itemsB: string[] = [];
    for (let index = 0; index < 4; index++) change(store, a.id, random, itemsA);
    // What the client held when it went away.
    let held: ThreadView | undefined;
    open(store, a.id, undefined, (sent) => {
      if (sent.type === "snapshot" && sent.view.kind === "thread") held = sent.view;
    })();
    if (!held) throw new Error("No snapshot");
    const away = held.seq;
    // What it missed.
    for (let index = 0; index < 20 + Math.floor(random() * 30); index++)
      change(store, a.id, random, itemsA);

    // Paced: pieces made one at a time; between them, live events on this thread and another,
    // and now and then the connection drops and the client resumes from what it applied.
    const paced = new Client(held);
    const wire: { thread: "a" | "b"; sent: ServerMessage }[] = [];
    const { gate, waiting } = testGate();
    let stop = open(
      store,
      a.id,
      away,
      (sent) => {
        wire.push({ thread: "a", sent });
        paced.apply(sent);
      },
      gate,
    );
    const other = open(store, b.id, store.headSeq(), (sent) => wire.push({ thread: "b", sent }));
    let pieces = 0;
    while (waiting.length) {
      pieces++;
      if (random() < 0.3) change(store, a.id, random, itemsA);
      if (pieces === 1 || random() < 0.3) change(store, b.id, random, itemsB);
      if (random() < 0.08) {
        // The connection drops between pieces: the client resumes from what it applied.
        stop();
        waiting.splice(0);
        stop = open(
          store,
          a.id,
          paced.cursor,
          (sent) => {
            wire.push({ thread: "a", sent });
            paced.apply(sent);
          },
          gate,
        );
        continue;
      }
      waiting.shift()?.();
    }
    stop();
    other();

    // One frame: the same client resuming once everything above had happened.
    const whole = new Client(held);
    open(store, a.id, away, (sent) => whole.apply(sent))();
    expect(paced.state(), `seed ${seed}`).toEqual(whole.state());
    // The replay really went in pieces, and the other thread was not held up behind them.
    const replayPieces = wire.filter(
      ({ thread, sent }) => thread === "a" && sent.type === "events",
    );
    expect(replayPieces.length, `seed ${seed}`).toBeGreaterThan(2);
    const firstOther = wire.findIndex(({ thread }) => thread === "b");
    const lastPiece = wire.findLastIndex(
      ({ thread, sent }) => thread === "a" && sent.type === "events" && sent.ack === true,
    );
    expect(firstOther, `seed ${seed}`).toBeGreaterThanOrEqual(0);
    expect(firstOther, `seed ${seed}`).toBeLessThan(lastPiece);
  }
});
