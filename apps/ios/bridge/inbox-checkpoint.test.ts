import { afterEach, describe, expect, test, vi } from "vitest";

vi.hoisted(() => {
  let next = 0;
  Object.assign(globalThis, {
    aceHost: {
      now: () => 0,
      uuid: () => `id-${++next}`,
      previewHead: (text: string, limit: number) => text.slice(0, limit),
      previewTail: (text: string, limit: number) => text.slice(-limit),
      emit: () => {},
      timer: () => {},
      cancelTimer: () => {},
      utf8Base64: (text: string) => Buffer.from(text, "utf8").toString("base64"),
    },
  });
});

import { FakeDaemon, facts } from "@ace/fake-daemon";
import { followInbox, type InboxClock } from "./inbox.ts";
import { checkpointDelayMs } from "./inbox-checkpoint.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * What the phone keeps between launches: nothing reaches it until the SDK holds a list, so the
 * rows it kept stay on screen, and the confirmed list is kept as an unconfirmed copy for the next
 * launch, read by the shared rules, so a finished thread reads Syncing there and never Done.
 */

class TestClock implements InboxClock {
  at = 5_000_000;
  timers: { due: number; run: () => void; live: boolean }[] = [];
  now = () => this.at;
  set = (delayMs: number, run: () => void) => {
    const timer = { due: this.at + delayMs, run, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
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
function working(daemon: FakeDaemon, id: string, title: string) {
  daemon.createThread({ id, workspaceId: "ace", title, provider: "codex", hasSentMessage: true });
  daemon.apply(id, [facts.rootAgent("codex"), facts.turn("root")]);
}

type Patch = {
  type: string;
  id?: string;
  ids?: string[];
  row?: { confirmed: boolean; status: { label: string } } | null;
  sections?: { key: string; ids: string[] }[];
};
const inboxKeys = (sink: RecordingSink) =>
  [...sink.readers.keys()].filter((key) => key.startsWith("inbox:"));

describe("inbox before its list is known", () => {
  test("the phone hears nothing until the SDK holds a list, then one reset naming every row", async () => {
    const { daemon, client } = sheetFixture();
    closers.push(() => client.close());
    finished(daemon, "done", "Done thread");
    working(daemon, "busy", "Busy thread");
    const sink = new RecordingSink();
    closers.push(followInbox(client, "mac", sink, new TestClock()));

    // Not started: an empty reset now would wipe the rows the phone kept from its last launch.
    expect(inboxKeys(sink)).toEqual([]);

    await client.start();
    await until(() => sink.read("inbox:reset") !== undefined, "first list");
    const reset = sink.read("inbox:reset") as Patch;
    expect(new Set(reset.ids)).toEqual(new Set(["done", "busy"]));
    expect((sink.read("inbox:done") as Patch).row?.status.label).toBe("Done");
    expect(sink.read("inbox:sections")).toBeDefined();
  });
});

describe("inbox checkpoint", () => {
  test("the confirmed list is kept with finished threads reading Syncing, never Done", async () => {
    const { daemon, client } = sheetFixture();
    closers.push(() => client.close());
    finished(daemon, "done", "Done thread");
    working(daemon, "busy", "Busy thread");
    await client.start();
    const clock = new TestClock();
    const sink = new RecordingSink();
    const saved: string[] = [];
    closers.push(
      followInbox(client, "mac", sink, clock, undefined, (checkpoint) => saved.push(checkpoint)),
    );
    await until(
      () => (sink.read("inbox:done") as Patch | undefined)?.row?.confirmed === true,
      "confirmed list",
    );
    expect(saved).toEqual([]);

    clock.advance(checkpointDelayMs);
    expect(saved).toHaveLength(1);
    const patches = JSON.parse(saved[0] ?? "[]") as Patch[];
    const [reset] = patches;
    expect(reset?.type).toBe("inbox.reset");
    expect(new Set(reset?.ids)).toEqual(new Set(["done", "busy"]));
    const row = (id: string) => patches.find((patch) => patch.id === id)?.row;
    // The live row says Done; the kept copy only says it is syncing until the daemon confirms.
    expect((sink.read("inbox:done") as Patch).row?.status.label).toBe("Done");
    expect(row("done")?.status.label).toBe("Syncing");
    expect(row("done")?.confirmed).toBe(false);
    expect(row("busy")?.confirmed).toBe(false);
    const sections = patches.at(-1);
    expect(sections?.type).toBe("inbox.sections");
    expect(sections?.sections?.flatMap((section) => section.ids).toSorted()).toEqual([
      "busy",
      "done",
    ]);
  });

  test("a list that stopped being the daemon's current one is not kept over the last good copy", async () => {
    const { daemon, client } = sheetFixture();
    closers.push(() => client.close());
    finished(daemon, "done", "Done thread");
    await client.start();
    const clock = new TestClock();
    const sink = new RecordingSink();
    const saved: string[] = [];
    closers.push(
      followInbox(client, "mac", sink, clock, undefined, (checkpoint) => saved.push(checkpoint)),
    );
    await until(
      () => (sink.read("inbox:done") as Patch | undefined)?.row?.confirmed === true,
      "confirmed list",
    );

    client.networkOnline(false);
    await until(
      () => (sink.read("inbox:done") as Patch | undefined)?.row?.confirmed === false,
      "offline",
    );
    clock.advance(checkpointDelayMs);
    expect(saved).toEqual([]);
  });
});
