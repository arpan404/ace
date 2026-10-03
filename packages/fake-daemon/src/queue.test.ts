import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { FakeDaemon, ScenarioPlayer, fakeTransport, longHistory } from "./index.ts";

const threadId = ThreadId.parse("thread-router");

/** A device on a fake daemon whose router thread is mid-turn, so sends queue. */
async function busyThread() {
  let now = 1000;
  const daemon = new FakeDaemon({ clock: () => (now += 1) });
  new ScenarioPlayer(daemon, longHistory(1)).runUntilBlocked();
  daemon.apply(threadId, [
    { type: "turn.started", agent: "root", nativeTurnId: "busy", trigger: "user" },
  ]);
  let ids = 0;
  const client = new Client({
    deviceId: DeviceId.parse("laptop"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `cmd-${++ids}`,
  });
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state !== "ready") return;
      stop();
      resolve();
    });
  });
  await client.start();
  await ready;
  const send = (text: string, id: string) =>
    client.command({ type: "thread.send", threadId, input: [{ type: "text", text }] }, {}, id);
  const queue = async () => (await client.request({ type: "queue.get", threadId })).queue;
  return { daemon, client, send, queue };
}

test("queued sends are listed in order and edits from a stale revision are refused", async () => {
  const f = await busyThread();
  try {
    await f.send("first", "q1");
    await f.send("second", "q2");
    const before = await f.queue();
    expect(before.messages.map((m) => m.id)).toEqual(["q1", "q2"]);

    const moved = await f.client.command({
      type: "queue.move",
      threadId,
      expectedRevision: before.revision,
      messageId: CommandId.parse("q2"),
      after: null,
    });
    expect(moved.ok).toBe(true);
    expect((await f.queue()).messages.map((m) => m.id)).toEqual(["q2", "q1"]);

    // Another device decided on the old revision.
    const stale = await f.client.command({
      type: "queue.remove",
      threadId,
      expectedRevision: before.revision,
      messageId: CommandId.parse("q1"),
    });
    expect(stale).toMatchObject({ ok: false, error: "queue_conflict" });
    expect((await f.queue()).total).toBe(2);
  } finally {
    await f.client.close();
  }
});

test("a usage limit holds the queue until resumed, and a timed resume needs a known reset", async () => {
  const f = await busyThread();
  try {
    await f.send("after the limit", "q1");
    f.daemon.apply(threadId, [
      {
        type: "turn.ended",
        agent: "root",
        outcome: "failed",
        error: { kind: "quota", message: "limit" },
      },
    ]);
    const held = await f.queue();
    expect(held).toMatchObject({ paused: true, reason: "limit", total: 1 });

    const timed = await f.client.command({
      type: "thread.limit",
      threadId,
      expectedRevision: held.revision,
      action: "resume_at_reset",
    });
    expect(timed).toMatchObject({ ok: false, error: "reset_time_unknown" });

    const resumed = await f.client.command({
      type: "thread.limit",
      threadId,
      expectedRevision: held.revision,
      action: "resume_now",
    });
    expect(resumed.ok).toBe(true);
    expect(await f.queue()).toMatchObject({ paused: false, total: 0 });
  } finally {
    await f.client.close();
  }
});
