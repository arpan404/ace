import { afterEach, describe, expect, test, vi } from "vitest";

vi.hoisted(() => {
  let next = 0;
  Object.assign(globalThis, {
    aceHost: {
      now: () => 0,
      uuid: () => `id-${++next}`,
      previewHead: (text: string, limit: number) => text.slice(0, limit),
      previewTail: (text: string, limit: number) => text.slice(-limit),
    },
  });
});

import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import { followInbox, type InboxClock } from "./inbox.ts";
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
