import { afterEach, expect, test, vi } from "vitest";
import { longHistory, ScenarioPlayer } from "@ace/fake-daemon";
import { CommandPayload, ThreadId } from "@ace/protocol";
import { cleanups, world } from "./worker-test-support.ts";

const noop = () => {};

afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

test("worker loss after a saved send keeps its original ID and recovery produces one daemon input", async () => {
  let saved: string | null = null;
  const f = world(undefined, {}, undefined, {
    load: async () => saved,
    save: async (value) => {
      saved = value;
    },
  });
  const scenario = new ScenarioPlayer(f.daemon, longHistory(1));
  scenario.runUntilBlocked();
  let fail = noop;
  const first = f.tab("local", {
    workerFailure: {
      watch(lost) {
        fail = lost;
        return () => {};
      },
    },
  });
  const healthy = f.tab();
  await Promise.all([first.start(), healthy.start()]);
  await vi.waitFor(() => expect(first.state).toBe("ready"));
  const lease = healthy.thread(scenario.threadId);
  await vi.waitFor(() => expect(lease.store.thread).toBeDefined());
  let release = noop;
  f.faults.incoming = (message, text, deliver) => {
    if (message.type === "commandResult" && message.commandId === "original-send")
      release = () => deliver(text);
    else deliver(text);
  };
  const payload = CommandPayload.parse({
    type: "thread.send",
    threadId: scenario.threadId,
    input: [{ type: "text", text: "Only once after worker loss" }],
  });
  await first.enqueue(payload, "original-send");
  await f.faults.wait(
    (message) => message.type === "commandResult" && message.commandId === "original-send",
  );
  fail();
  expect(first.state).toBe("fatal");
  expect(first.pendingSends().getSnapshot()).toContainEqual(
    expect.objectContaining({
      commandId: "original-send",
      state: expect.not.stringMatching(/^failed$/),
    }),
  );
  await first.close();
  await first.left;
  expect(healthy.state).toBe("ready");
  // After proving isolation, discard the entire warm host so recovery reads persisted work.
  lease.release();
  await healthy.close();
  await healthy.left;
  f.advance(30);
  f.faults.incoming = (_message, text, deliver) => deliver(text);
  release();
  const retry = f.tab();
  await retry.start();
  expect(await retry.command(payload, {}, "original-send")).toMatchObject({
    commandId: "original-send",
    ok: true,
  });
  const page = await retry.itemsPage({ threadId: scenario.threadId, limit: 100 });
  expect(page.items.filter((item) => item.id === "input:original-send")).toHaveLength(1);
  expect(
    f.daemon
      .replay({ kind: "thread", threadId: ThreadId.parse(scenario.threadId) }, 0)
      .filter(
        (event) =>
          event.payload.type === "item.created" && event.payload.item.id === "input:original-send",
      ),
  ).toHaveLength(1);
});
