import { afterEach, describe, expect, test, vi } from "vitest";

vi.hoisted(async () => {
  const { createNodeHost } = await import("@ace/native-host/node");
  Object.assign(globalThis, { aceHost: createNodeHost({ now: () => 0, emit: () => {} }) });
});

import { CommandId, DeviceId, ThreadId, type CommandPayload } from "@ace/protocol";
import { FakeDaemon, facts } from "@ace/fake-daemon";
import { followInbox, inboxAction, type InboxClock } from "./inbox.ts";
import { inboxCheckpoint } from "./inbox-checkpoint.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * The inbox's section totals over the real SDK and the fake daemon. The daemon pages settled
 * threads (twenty at a time), so the phone holds only some of them; the Settled heading still
 * shows the daemon's count, as the web's sidebar does, and moves as threads settle live.
 */

const clock: InboxClock = { now: () => 5_000_000, set: () => () => {} };
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

let commands = 0;
function command(daemon: FakeDaemon, payload: CommandPayload) {
  daemon.command({
    id: CommandId.parse(`seed-${++commands}`),
    deviceId: DeviceId.parse("seed"),
    payload,
  });
}
function finished(daemon: FakeDaemon, id: string) {
  daemon.createThread({
    id,
    workspaceId: "ace",
    title: id,
    provider: "codex",
    hasSentMessage: true,
  });
  daemon.apply(id, [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
}
function settledThreads(daemon: FakeDaemon, count: number) {
  for (let index = 0; index < count; index += 1) {
    finished(daemon, `old-${index}`);
    command(daemon, { type: "thread.settle", threadId: ThreadId.parse(`old-${index}`) });
  }
}

async function following(seed: (daemon: FakeDaemon) => void) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  seed(daemon);
  await client.start();
  const sink = new RecordingSink();
  closers.push(followInbox(client, "mac", sink, clock));
  return { daemon, client, sink };
}

type Section = { key: string; ids: string[]; total: number };
const section = (patches: Record<string, unknown> | undefined, key: string) =>
  ((patches as { sections?: Section[] } | undefined)?.sections ?? []).find(
    (each) => each.key === key,
  );
const settled = (sink: RecordingSink) => section(sink.read("inbox:sections"), "settled");

describe("inbox section totals", () => {
  test("the settled section shows the daemon's total before any older page is loaded", async () => {
    const { sink } = await following((daemon) => settledThreads(daemon, 25));
    await until(() => settled(sink) !== undefined, "settled section");
    expect(settled(sink)?.ids.length).toBeLessThan(25);
    expect(settled(sink)?.total).toBe(25);
    expect((sink.read("inbox:sections") as { more: boolean }).more).toBe(true);
  });

  test("the total moves when a thread settles and when one is unsettled", async () => {
    const { client, sink } = await following((daemon) => {
      settledThreads(daemon, 25);
      finished(daemon, "notes");
    });
    await until(() => settled(sink)?.total === 25, "25 settled");

    inboxAction(client, { kind: "settle", threadId: "notes" }, "settle-1", sink);
    await until(() => settled(sink)?.total === 26, "26 settled");

    inboxAction(client, { kind: "unsettle", threadId: "notes" }, "unsettle-1", sink);
    await until(() => settled(sink)?.total === 25, "back to 25");
  });

  test("the total stays the same once every older page is loaded", async () => {
    const { client, sink } = await following((daemon) => settledThreads(daemon, 25));
    await until(() => settled(sink)?.total === 25, "25 settled");
    inboxAction(client, { kind: "more" }, "more-1", sink);
    await until(() => settled(sink)?.ids.length === 25, "every settled row");
    expect(settled(sink)?.total).toBe(25);
  });

  test("the launch checkpoint reads its settled copies as Syncing and claims no Settled total", async () => {
    const { client, sink } = await following((daemon) => settledThreads(daemon, 25));
    await until(() => settled(sink)?.total === 25, "25 settled");
    const patches = inboxCheckpoint(client.threads().store, {
      machineId: "mac",
      now: clock.now(),
      baseline: clock.now(),
      accounts: [],
    });
    const layout = patches.find((patch) => patch.type === "inbox.sections");
    // Until the daemon confirms them, the kept rows wait under Syncing; counting the daemon's
    // total under Settled as well would show those threads twice.
    expect(section(layout, "settled")).toBeUndefined();
    expect(section(layout, "syncing")?.ids.length).toBe(settled(sink)?.ids.length);
  });
});
