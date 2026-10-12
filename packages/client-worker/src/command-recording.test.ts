import { ThreadId } from "@ace/protocol";
import { flakyCheckout, ScenarioPlayer } from "@ace/fake-daemon";
import { afterEach, expect, test } from "vitest";
import { RemoteClient } from "./index.ts";
import { cleanups, world, timers } from "./worker-test-support.ts";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test("loss of the recording owner tab releases its unsent ID for another tab without a late dispatch", async () => {
  const released = Promise.withResolvers<() => void>();
  const { daemon, host, tab } = world(undefined, {
    lockReleased(_name, gone) {
      released.resolve(gone);
      return () => {};
    },
  });
  const scenario = new ScenarioPlayer(daemon, flakyCheckout());
  scenario.runUntilBlocked();
  const { port1, port2 } = new MessageChannel();
  host.attach(port1);
  const owner = new RemoteClient(
    port2,
    { daemon: "local" },
    {
      scheduler: timers,
      liveness: { hold: async () => ({ name: "recording-owner", release() {} }) },
    },
  );
  cleanups.push(() => owner.close());
  const competitor = tab();
  await owner.start();
  await competitor.start();
  const exposed = Promise.withResolvers<string>();
  const gate = Promise.withResolvers<void>();
  const payload = { type: "thread.archive", threadId: ThreadId.parse(scenario.threadId) } as const;
  const submission = owner
    .submitNew(payload, async (id) => {
      exposed.resolve(id);
      await gate.promise;
    })
    .catch((error: unknown) => error);
  const id = await exposed.promise;
  await expect(competitor.command(payload, {}, id)).rejects.toMatchObject({ code: "limit" });
  // Simulate the browser process dying: the worker sees lock loss, with no bye or recording ack.
  const drop = await released.promise;
  drop();
  expect(
    await competitor.command(
      {
        type: "thread.rename",
        threadId: payload.threadId,
        title: "Surviving tab",
      },
      {},
      id,
    ),
  ).toMatchObject({ ok: true, commandId: id });
  gate.resolve();
  await competitor.itemsPage({ threadId: scenario.threadId, limit: 1 });
  const after = daemon.snapshot({ kind: "threads" });
  expect(
    after?.kind === "threads" ? after.threads[scenario.threadId]?.archivedAt : undefined,
  ).toBeUndefined();
  expect(after?.kind === "threads" ? after.threads[scenario.threadId]?.title : undefined).toBe(
    "Surviving tab",
  );
  await owner.close();
  await submission;
});
