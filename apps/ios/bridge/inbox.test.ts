import { afterEach, describe, expect, test, vi } from "vitest";

const { pumpFrames, pumpTimers } = await vi.hoisted(async () => {
  const { createNodeHost } = await import("@ace/native-host/node");
  const frames: Record<string, unknown>[][] = [];
  const timers = new Map<string, () => void>();
  const host = createNodeHost({
    now: () => 0,
    emit: (frame) => {
      frames.push(JSON.parse(frame) as Record<string, unknown>[]);
    },
  });
  Object.assign(globalThis, {
    aceHost: {
      ...host,
      // The tests run the pump's timers by hand.
      timer: (id: string, _delay: number, callback: () => void) => {
        timers.set(id, callback);
      },
      cancelTimer: (id: string) => {
        timers.delete(id);
      },
    },
  });
  return { pumpFrames: frames, pumpTimers: timers };
});

import { CommandId, DeviceId, InteractionRequest, ThreadId } from "@ace/protocol";
import { Client } from "@ace/client";
import { FakeDaemon, facts } from "@ace/fake-daemon";
import { followInbox, inboxAction, type InboxClock } from "./inbox.ts";
import { PatchPump } from "./patch-pump.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * The inbox follower over the real SDK and the fake daemon, with the phone's clock injected:
 * a snooze runs out on the phone's own time, even while its machine (which would wake the
 * thread) says nothing.
 */

const minute = 60_000;
const start = 5_000_000;

/** The phone's clock: time moves only when the test says, and due timers fire then. */
class TestClock implements InboxClock {
  at = start;
  timers: { due: number; run: () => void; live: boolean }[] = [];
  now = () => this.at;
  set = (delayMs: number, run: () => void) => {
    const timer = { due: this.at + delayMs, run, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  get armed() {
    return this.timers.filter((timer) => timer.live).map((timer) => timer.due);
  }
  advance(ms: number) {
    this.at += ms;
    for (const timer of this.timers.splice(0))
      if (timer.live && timer.due <= this.at) timer.run();
      else this.timers.push(timer);
  }
}

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

function finished(daemon: FakeDaemon, id: string, title: string) {
  daemon.createThread({ id, workspaceId: "ace", title, provider: "codex", hasSentMessage: true });
  daemon.apply(id, [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
}
function snooze(daemon: FakeDaemon, id: string, at: number) {
  daemon.command({
    id: CommandId.parse(`snooze-${id}`),
    deviceId: DeviceId.parse("seed"),
    payload: { type: "thread.snooze", threadId: ThreadId.parse(id), until: at },
  });
}

async function following(seed: (daemon: FakeDaemon) => void) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  seed(daemon);
  await client.start();
  const clock = new TestClock();
  const sink = new RecordingSink();
  closers.push(followInbox(client, "mac", sink, clock));
  return { daemon, client, clock, sink };
}

type Sections = { sections: { key: string; ids: string[] }[] };
const groups = (sink: RecordingSink) =>
  Object.fromEntries(
    ((sink.read("inbox:sections") as Sections | undefined)?.sections ?? []).map((section) => [
      section.key,
      section.ids,
    ]),
  );
const status = (sink: RecordingSink, id: string) =>
  (sink.read(`inbox:${id}`) as { row: { status: { label: string; token: string } } } | undefined)
    ?.row.status;

/** The real pump emits here and arms timers here; the test drives both by hand. */
function runPumpTimers() {
  const pending = [...pumpTimers.values()];
  pumpTimers.clear();
  for (const run of pending) run();
}

type DeliveredConnectionPatch = { type: "connection"; state: string; generation: unknown };
type DeliveredInboxRowPatch = {
  type: "inbox.row";
  id: string;
  row: { confirmed: unknown; generation: unknown; state: unknown } | null;
};
function patchesOf<T>(type: string): T[] {
  const out: T[] = [];
  for (const frame of pumpFrames)
    for (const patch of frame)
      if ((patch as { type?: unknown }).type === type) out.push(patch as T);
  return out;
}
function lastOf<T>(patches: T[]): T | undefined {
  return patches.length === 0 ? undefined : patches[patches.length - 1];
}

function lastCachedRow() {
  const rows = patchesOf<DeliveredInboxRowPatch>("inbox.row").filter(
    (patch) => patch.id === "cached",
  );
  return rows.at(-1)?.row;
}
function lastConnection() {
  return lastOf(patchesOf<DeliveredConnectionPatch>("connection"));
}

/** Drive the real pump until delivered frames satisfy `cond`: flush, inspect, ack, repeat. */
async function drivePumpUntil(pump: PatchPump, cond: () => boolean, label: string) {
  for (let i = 0; i < 500; i++) {
    runPumpTimers();
    if (cond()) return;
    pump.ack(true);
    runPumpTimers();
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out: ${label}`);
}

describe("inbox snooze expiry", () => {
  test("a snooze that ends while the machine stays silent regroups the row as Snooze ended", async () => {
    const { clock, sink } = await following((daemon) => {
      finished(daemon, "nap", "Release notes");
      snooze(daemon, "nap", start + 5 * minute);
    });
    await until(() => groups(sink).snoozed?.includes("nap") === true, "snoozed");
    expect(clock.armed).toEqual([start + 5 * minute]);

    clock.advance(4 * minute);
    expect(groups(sink).snoozed).toEqual(["nap"]);
    expect(status(sink, "nap")?.label).toBe("Done");

    // Nothing arrives from the daemon; the phone's own clock ends the snooze.
    clock.advance(minute);
    expect(groups(sink).snoozed).toBeUndefined();
    expect(groups(sink).done).toEqual(["nap"]);
    expect(status(sink, "nap")).toEqual({ label: "Snooze ended", token: "done" });
    expect(clock.armed).toEqual([]);
  });

  test("each snooze ends at its own time, soonest first", async () => {
    const { clock, sink } = await following((daemon) => {
      finished(daemon, "soon", "Soon");
      finished(daemon, "later", "Later");
      snooze(daemon, "soon", start + minute);
      snooze(daemon, "later", start + 30 * minute);
    });
    await until(() => groups(sink).snoozed?.length === 2, "snoozed");
    clock.advance(minute);
    expect(groups(sink)).toMatchObject({ done: ["soon"], snoozed: ["later"] });
    expect(clock.armed).toEqual([start + 30 * minute]);
    clock.advance(29 * minute);
    expect(groups(sink).done).toEqual(expect.arrayContaining(["soon", "later"]));
    expect(groups(sink).snoozed).toBeUndefined();
  });

  test("waking a thread early cancels its timer", async () => {
    const { daemon, clock, sink } = await following((seeded) => {
      finished(seeded, "nap", "Nap");
      snooze(seeded, "nap", start + 10 * minute);
    });
    await until(() => groups(sink).snoozed !== undefined && clock.armed.length === 1, "armed");
    daemon.command({
      id: CommandId.parse("wake"),
      deviceId: DeviceId.parse("seed"),
      payload: { type: "thread.snooze", threadId: ThreadId.parse("nap"), until: null },
    });
    await until(() => groups(sink).done?.includes("nap") === true, "woken");
    expect(clock.armed).toEqual([]);
    expect(status(sink, "nap")?.label).toBe("Done");
  });

  test("closing the inbox stops its timer", async () => {
    const { client, clock, sink } = await following((seeded) => {
      finished(seeded, "nap", "Nap");
      snooze(seeded, "nap", start + 10 * minute);
    });
    await until(() => groups(sink).snoozed !== undefined && clock.armed.length === 1, "armed");
    const second = new RecordingSink();
    const stop = followInbox(client, "mac", second, clock);
    expect(groups(second).snoozed).toEqual(["nap"]);
    expect(clock.armed).toHaveLength(2);
    stop();
    // Only the open follower's timer remains.
    expect(clock.armed).toEqual([start + 10 * minute]);
  });
});

describe("inbox attention", () => {
  type Look = {
    level: string;
    word: string | null;
    tone: string;
    muted: boolean;
    glyph: string | null;
  };
  const look = (sink: RecordingSink, id: string) =>
    (sink.read(`inbox:${id}`) as { row: { look: Look } } | undefined)?.row.look;

  test("only the row asking for the person is loud; working recedes and a seen result shows its age", async () => {
    const { sink } = await following((daemon) => {
      finished(daemon, "notes", "Notes");
      daemon.createThread({ id: "busy", workspaceId: "ace", title: "Busy", provider: "codex" });
      daemon.apply("busy", [facts.rootAgent("codex"), facts.turn("root")]);
      daemon.createThread({ id: "asks", workspaceId: "ace", title: "Asks", provider: "claude" });
      daemon.apply("asks", [
        facts.rootAgent("claude"),
        facts.turn("root"),
        {
          type: "interaction.opened",
          agent: "root",
          interaction: "ask",
          blocking: true,
          request: InteractionRequest.parse({
            kind: "approval",
            title: "Run the tests",
            options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
          }),
        },
      ]);
    });
    await until(() => look(sink, "asks")?.level === "needs-you", "the request");
    expect(look(sink, "asks")).toEqual({
      level: "needs-you",
      word: "Approve",
      tone: "needs-you",
      muted: false,
      glyph: "needs-you",
      since: null,
      settled: false,
      subagents: 0,
    });
    await until(() => look(sink, "busy")?.level === "active", "the working row");
    expect(look(sink, "busy")).toMatchObject({
      word: "Working",
      tone: "working",
      muted: true,
      glyph: "working",
    });
    // Finished before the phone started following: read, so it claims no word, only its age.
    expect(look(sink, "notes")).toMatchObject({
      level: "quiet",
      word: null,
      muted: true,
      glyph: null,
    });
  });
});

const account = (sink: RecordingSink, id: string) =>
  (sink.read(`inbox:${id}`) as { row: { account: string | null } } | undefined)?.row.account;
const execution = (instanceId: string) => ({
  provider: "codex" as const,
  model: "gpt-5.5",
  instanceId,
  options: {},
});

describe("inbox provider accounts", () => {
  test("a row on one of several accounts wears that account's mark; the CLI's own login stays plain", async () => {
    const { sink } = await following((daemon) => {
      daemon.createThread({
        id: "team",
        workspaceId: "ace",
        title: "Team",
        provider: "codex",
        execution: execution("codex-team"),
      });
      daemon.createThread({
        id: "plain",
        workspaceId: "ace",
        title: "Plain",
        provider: "codex",
        execution: execution("codex-cli-default"),
      });
    });
    await until(() => account(sink, "team") != null, "the account bubble");
    expect(account(sink, "team")).toBe("T");
    expect(account(sink, "plain")).toBeNull();
  });
});

describe("inbox settling", () => {
  test("settling a finished thread moves it to Settled, and unsettling brings it back to Done", async () => {
    const { client, sink } = await following((daemon) => finished(daemon, "notes", "Notes"));
    await until(() => groups(sink).done?.includes("notes") === true, "done");

    inboxAction(client, { kind: "settle", threadId: "notes" }, "settle-1", sink);
    await until(() => groups(sink).settled?.includes("notes") === true, "settled");
    expect(groups(sink).done).toBeUndefined();
    expect(sink.read("admission:settle-1")).toMatchObject({ ok: true });

    inboxAction(client, { kind: "unsettle", threadId: "notes" }, "unsettle-1", sink);
    await until(() => groups(sink).done?.includes("notes") === true, "unsettled");
    expect(groups(sink).settled).toBeUndefined();
  });
});

describe("inbox rows on the phone", () => {
  test("a thread leaving the list takes only its own row; the phone never blanks the rest", async () => {
    pumpFrames.length = 0;
    pumpTimers.clear();
    const { daemon, client } = sheetFixture();
    closers.push(() => client.close());
    finished(daemon, "keep", "Keep");
    finished(daemon, "leave", "Leave");
    // More rows than one bounded frame holds, so a reset could never refill them at once.
    for (let filler = 0; filler < 35; filler++)
      finished(daemon, `filler-${filler}`, `Filler ${filler}`);
    await client.start();
    const pump = new PatchPump();
    closers.push(followInbox(client, "mac", pump, new TestClock()));

    // The phone applies each delivered frame the way ClientModel does.
    const phone = new Map<string, unknown>();
    let applied = 0;
    let keepLost = false;
    const sync = () => {
      for (const frame of pumpFrames.slice(applied))
        for (const patch of frame as { type?: string; id?: string; row?: unknown }[]) {
          if (patch.type === "inbox.reset") phone.clear();
          if (patch.type === "inbox.row" && patch.id !== undefined)
            if (patch.row) phone.set(patch.id, patch.row);
            else phone.delete(patch.id);
        }
      applied = pumpFrames.length;
      return true;
    };
    await drivePumpUntil(pump, () => sync() && phone.has("leave") && phone.has("keep"), "listed");
    const watch = () => {
      sync();
      if (!phone.has("keep")) keepLost = true;
    };

    inboxAction(client, { kind: "archive", threadId: "leave" }, "archive-1", pump);
    await drivePumpUntil(
      pump,
      () => {
        watch();
        return !phone.has("leave");
      },
      "archived",
    );
    expect(keepLost).toBe(false);
    expect(phone.has("filler-0")).toBe(true);
  });
});

describe("inbox traffic", () => {
  test("one thread starting work among many re-sends only that thread's row", async () => {
    const { daemon, sink } = await following((seed) => {
      for (let index = 0; index < 40; index++) finished(seed, `busy-${index}`, `Busy ${index}`);
    });
    await until(() => status(sink, "busy-7") !== undefined, "listed");
    const written: string[] = [];
    const put = sink.put.bind(sink);
    sink.put = (key, read) => {
      written.push(key);
      put(key, read);
    };
    daemon.apply("busy-7", [
      { type: "turn.started", agent: "root", nativeTurnId: "next", trigger: "user" },
    ]);
    await until(() => status(sink, "busy-7")?.label === "Working", "working");
    const rows = new Set(
      written.filter((key) => key.startsWith("inbox:") && key !== "inbox:sections"),
    );
    expect([...rows]).toEqual(["inbox:busy-7"]);
  });

  test("a thread joining the list sends its own row without re-sending the others", async () => {
    const { daemon, sink } = await following((seed) => {
      for (let index = 0; index < 40; index++) finished(seed, `old-${index}`, `Old ${index}`);
    });
    await until(() => status(sink, "old-0") !== undefined, "listed");
    const written: string[] = [];
    const put = sink.put.bind(sink);
    sink.put = (key, read) => {
      written.push(key);
      put(key, read);
    };
    finished(daemon, "new", "New");
    await until(() => status(sink, "new") !== undefined, "joined");
    const rows = new Set(
      written.filter((key) => key.startsWith("inbox:") && key !== "inbox:sections"),
    );
    expect([...rows]).toEqual(["inbox:new"]);
  });
});

describe("inbox confirmation", () => {
  test("ready alone never confirms a cached done row; confirmed working arrives only with its snapshot", async () => {
    let now = 1_000;
    let ids = 0;
    const daemon = new FakeDaemon({ clock: () => (now += 1) });
    daemon.createThread({
      id: "cached",
      workspaceId: "ace",
      title: "Cached",
      provider: "codex",
      hasSentMessage: true,
    });
    daemon.apply("cached", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);

    let gateSnapshots = false;
    const held: string[] = [];
    let liveMessage: ((text: string) => void) | undefined;
    const gated = () => {
      let connection: ReturnType<FakeDaemon["connect"]> | undefined;
      let detach: (() => void) | undefined;
      return {
        open(events: { message(text: string): void; close(code: number): void; open(): void }) {
          liveMessage = (text: string) => events.message(text);
          detach?.();
          let live = true;
          detach = () => {
            live = false;
          };
          const wire = {
            send: (text: string) => {
              try {
                const message = JSON.parse(text) as { type?: string; view?: { kind?: string } };
                if (
                  gateSnapshots &&
                  message.type === "snapshot" &&
                  message.view?.kind === "threads"
                ) {
                  held.push(text);
                  return;
                }
              } catch {
                // Non-JSON frames still deliver; only gated snapshots hold.
              }
              queueMicrotask(() => {
                if (live) events.message(text);
              });
            },
            close: (code: number) =>
              queueMicrotask(() => {
                if (!live) return;
                live = false;
                events.close(code);
              }),
          };
          const opened = daemon.connect(wire);
          connection?.close();
          connection = opened;
          queueMicrotask(() => {
            if (live) events.open();
          });
        },
        send(text: string) {
          const target = connection;
          if (!target) throw new Error("Transport not open");
          queueMicrotask(() => target.receive(text));
        },
        close() {
          detach?.();
          detach = undefined;
          liveMessage = undefined;
          connection?.close();
          connection = undefined;
        },
      };
    };
    const client = new Client({
      deviceId: DeviceId.parse("ios-confirmation-device"),
      transport: gated,
      credential: async () => daemon.token,
      storage: { load: async () => null, save: async () => {} },
      scheduler: {
        set(delayMs, callback) {
          const timer = setTimeout(callback, delayMs);
          return () => clearTimeout(timer);
        },
      },
      random: () => 0.5,
      id: () => `id-${++ids}`,
    });
    closers.push(() => client.close());
    await client.start();
    const clock = new TestClock();
    const sink = new RecordingSink();
    closers.push(followInbox(client, "mac", sink, clock));

    const row = () =>
      sink.read("inbox:cached") as
        | {
            row: {
              confirmed: boolean;
              generation: number;
              state: string;
              status: { label: string };
            } | null;
          }
        | undefined;
    await until(
      () => row()?.row?.confirmed === true && row()?.row?.state === "done",
      "confirmed done",
    );
    expect(row()?.row?.status.label).toBe("Done");
    const settledGeneration = row()?.row?.generation;
    expect(typeof settledGeneration).toBe("number");

    // Stay offline while the daemon keeps working elsewhere: the cached copy must lose freshness.
    gateSnapshots = true;
    client.networkOnline(false);
    await until(
      () => client.connectionState().getSnapshot() !== "ready" && row()?.row?.confirmed === false,
      "unconfirmed offline",
    );
    expect(row()?.row?.state).toBe("done");
    // Losing confirmation advances the fence so older confirmed rows stop matching.
    expect(row()?.row?.generation).toBeGreaterThan(settledGeneration ?? -1);
    const lostGeneration = row()?.row?.generation ?? -1;

    daemon.apply("cached", [
      { type: "turn.started", agent: "root", nativeTurnId: "root-turn-2", trigger: "user" },
    ]);

    // Reconnect with the sidebar snapshot still held: welcome makes the connection ready, but
    // the cached done row must stay unconfirmed until its snapshot lands.
    client.networkOnline(true);
    await until(() => client.connectionState().getSnapshot() === "ready", "welcome ready");
    expect(row()?.row?.confirmed).toBe(false);
    expect(row()?.row?.state).toBe("done");

    gateSnapshots = false;
    for (const text of held.splice(0)) liveMessage?.(text);
    await until(
      () => row()?.row?.confirmed === true && row()?.row?.state === "working",
      "confirmed working",
    );
    // Confirming the new snapshot keeps the fence; it never rolls back.
    expect(row()?.row?.generation).toBe(lostGeneration);
  });

  test("a coalesced offline-to-ready delivers its advanced fence before the delayed target row", async () => {
    pumpFrames.length = 0;
    pumpTimers.clear();
    let now = 1_000;
    let ids = 0;
    const daemon = new FakeDaemon({ clock: () => (now += 1) });
    // Enough filler rows that one bounded frame cannot hold the connection, every row
    // and the sections: the target row is the oldest, so its invalidation lands in a
    // later frame than the advanced connection fence.
    daemon.createThread({
      id: "cached",
      workspaceId: "ace",
      title: "Cached",
      provider: "codex",
      hasSentMessage: true,
    });
    daemon.apply("cached", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
    for (let filler = 0; filler < 35; filler++)
      finished(daemon, `filler-${filler}`, `Filler ${filler}`);

    let gateSnapshots = false;
    const held: string[] = [];
    let liveMessage: ((text: string) => void) | undefined;
    const gated = () => {
      let connection: ReturnType<FakeDaemon["connect"]> | undefined;
      let detach: (() => void) | undefined;
      return {
        open(events: { message(text: string): void; close(code: number): void; open(): void }) {
          liveMessage = (text: string) => events.message(text);
          detach?.();
          let live = true;
          detach = () => {
            live = false;
          };
          const wire = {
            send: (text: string) => {
              try {
                const message = JSON.parse(text) as { type?: string; view?: { kind?: string } };
                if (
                  gateSnapshots &&
                  message.type === "snapshot" &&
                  message.view?.kind === "threads"
                ) {
                  held.push(text);
                  return;
                }
              } catch {
                // Non-JSON frames still deliver; only gated snapshots hold.
              }
              queueMicrotask(() => {
                if (live) events.message(text);
              });
            },
            close: (code: number) =>
              queueMicrotask(() => {
                if (!live) return;
                live = false;
                events.close(code);
              }),
          };
          const opened = daemon.connect(wire);
          connection?.close();
          connection = opened;
          queueMicrotask(() => {
            if (live) events.open();
          });
        },
        send(text: string) {
          const target = connection;
          if (!target) throw new Error("Transport not open");
          queueMicrotask(() => target.receive(text));
        },
        close() {
          detach?.();
          detach = undefined;
          liveMessage = undefined;
          connection?.close();
          connection = undefined;
        },
      };
    };
    const client = new Client({
      deviceId: DeviceId.parse("ios-coalesced-pump-device"),
      transport: gated,
      credential: async () => daemon.token,
      storage: { load: async () => null, save: async () => {} },
      scheduler: {
        set(delayMs, callback) {
          const timer = setTimeout(callback, delayMs);
          return () => clearTimeout(timer);
        },
      },
      random: () => 0.5,
      id: () => `id-${++ids}`,
    });
    closers.push(() => client.close());
    await client.start();
    const clock = new TestClock();
    const pump = new PatchPump();
    closers.push(followInbox(client, "mac", pump, clock));

    await drivePumpUntil(
      pump,
      () => lastCachedRow()?.confirmed === true && lastCachedRow()?.state === "done",
      "settled done",
    );
    // Drain the quiet pump so the transition starts from known delivered frames.
    for (let i = 0; i < 10; i++) {
      pump.ack(true);
      runPumpTimers();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const settledFrameCount = pumpFrames.length;
    const settledConnection = lastConnection();
    expect(typeof settledConnection?.generation).toBe("number");
    const settledGeneration = settledConnection?.generation as number;
    expect(lastCachedRow()?.generation).toBe(settledGeneration);

    // Coalesce the drop and the restore before either is observed, holding every ack so
    // the pump cannot flush until the test says so: offline and ready collapse into one
    // ready connection patch while the sidebar snapshot stays gated.
    gateSnapshots = true;
    client.networkOnline(false);
    client.networkOnline(true);
    daemon.apply("cached", [
      { type: "turn.started", agent: "root", nativeTurnId: "root-turn-2", trigger: "user" },
    ]);
    await until(() => client.connectionState().getSnapshot() === "ready", "coalesced ready");

    // Exactly one bounded frame arrives: the advanced connection fence rides along while
    // the target row's invalidation is still queued behind the filler rows.
    runPumpTimers();
    expect(pumpFrames.length).toBe(settledFrameCount + 1);
    const advanced = lastConnection();
    expect(advanced?.state).toBe("ready");
    expect(typeof advanced?.generation).toBe("number");
    const advancedGeneration = advanced?.generation as number;
    expect(advancedGeneration).toBeGreaterThan(settledGeneration);
    const frame = pumpFrames[pumpFrames.length - 1] ?? [];
    expect(
      frame.some(
        (patch) =>
          (patch as { type?: unknown }).type === "inbox.row" &&
          (patch as { id?: unknown }).id === "cached",
      ),
    ).toBe(false);
    // The only cached row delivered so far still claims its old Done: the advanced fence
    // is what stops a native from ending on it before the invalidation lands.
    const retained = lastCachedRow();
    expect(retained?.confirmed).toBe(true);
    expect(retained?.generation).toBe(settledGeneration);

    pump.ack(true);
    await drivePumpUntil(
      pump,
      () => {
        const row = lastCachedRow();
        return (
          row != null &&
          row.confirmed === false &&
          typeof row.generation === "number" &&
          row.generation > settledGeneration
        );
      },
      "invalidated row",
    );
    // The invalidation carries the same fence as the connection: atomic, never rolled back.
    expect(lastCachedRow()?.generation).toBe(advancedGeneration);

    gateSnapshots = false;
    for (const text of held.splice(0)) liveMessage?.(text);
    await drivePumpUntil(
      pump,
      () => lastCachedRow()?.confirmed === true && lastCachedRow()?.state === "working",
      "coalesced working",
    );
    expect(lastCachedRow()?.generation).toBe(advancedGeneration);
  });
});
