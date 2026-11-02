// Real engine and SQLite store: a message's files stay leased until the run that reads them
// ends, which only the engine's fold of provider frames, Stops and exits decides.
import { afterEach, expect, test } from "vitest";
import { CommandId, type Command } from "@ace/protocol";
import { fixture, cleanupRecovery, text, sends } from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";
afterEach(cleanupRecovery);

const image = { mentions: [], attachments: [{ sha256: "a".repeat(64) }] };

/** Files prepared for the provider, refused past a small bound the way the attachment store is. */
function files(bound = 4, gate?: () => Promise<void>) {
  let held = 0;
  let prepared = 0;
  return {
    held: () => held,
    prepared: () => prepared,
    async prepareInput(command: Command) {
      if (command.payload.type !== "thread.send") throw new Error("Expected a send");
      await gate?.();
      if (held >= bound) throw new Error("Attachments are still being read");
      held++;
      prepared++;
      let released = false;
      return {
        input: command.payload.input,
        release: () => {
          if (released) return;
          released = true;
          held--;
        },
      };
    },
  };
}

async function idleThread(options: Parameters<typeof fixture>[2] = {}) {
  const frames = scriptFrames();
  const h = await fixture([], frames, options);
  const id = await h.create();
  const provider = h.contexts[0];
  if (!provider) throw new Error("Missing provider session");
  await provider.onFrame(frames.frame(start, end));
  await h.engine.flush();
  const run = async (...facts: Parameters<typeof frames.frame>) => {
    await provider.onFrame(frames.frame(...facts));
    await h.engine.flush();
  };
  return { h, id, provider, frames, run };
}

test("a thread taking 200 image messages, sent, steered mid-run and queued then removed, keeps accepting them", async () => {
  const leases = files();
  const { h, id, run } = await idleThread({ steer: true, prepareInput: leases.prepareInput });
  let delivered = 0;
  for (let i = 0; i < 200; i++) {
    const kind = i % 3;
    if (kind === 0) {
      h.command({ type: "thread.send", threadId: id, input: text(`send ${i}`), context: image });
      await h.engine.flush();
      await run(start, end);
      delivered++;
    } else if (kind === 1) {
      await run(start);
      h.command({
        type: "thread.send",
        threadId: id,
        input: text(`steer ${i}`),
        context: image,
        delivery: "steer",
      });
      await h.engine.flush();
      await run(end);
      delivered++;
    } else {
      await run(start);
      const messageId = CommandId.parse(`queued-${i}`);
      h.command(
        { type: "thread.send", threadId: id, input: text(`queued ${i}`), context: image },
        "device",
        messageId,
      );
      await h.engine.flush();
      const revision = h.engine.queue(id).revision;
      expect(
        h.command({ type: "queue.remove", threadId: id, expectedRevision: revision, messageId }).ok,
      ).toBe(true);
      await run(end);
    }
  }
  expect(leases.prepared()).toBe(delivered);
  expect(sends(h.adapter)).toHaveLength(delivered + 1);
  expect(leases.held()).toBe(0);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("a steer keeps its files until its run ends, whether it completes, fails or is stopped", async () => {
  const leases = files();
  const { h, id, run } = await idleThread({ steer: true, prepareInput: leases.prepareInput });
  for (const outcome of ["completed", "failed", "interrupted"] as const) {
    await run(start);
    h.command({
      type: "thread.send",
      threadId: id,
      input: text(outcome),
      context: image,
      delivery: "steer",
    });
    await h.engine.flush();
    expect(leases.held()).toBe(1);
    await run({ ...end, outcome });
    expect(leases.held()).toBe(0);
  }
});

test("a message the provider never started a turn for is released when the provider exits", async () => {
  const leases = files();
  const { h, id, provider } = await idleThread({ prepareInput: leases.prepareInput });
  h.command({ type: "thread.send", threadId: id, input: text("look"), context: image });
  await h.engine.flush();
  expect(leases.held()).toBe(1);
  provider.onExit({ deliberate: false, message: "crashed" });
  await h.engine.flush();
  expect(leases.held()).toBe(0);
});

test("a Stop the provider can't confirm releases the files of the run it ends", async () => {
  const leases = files();
  const frames = scriptFrames();
  const h = await fixture(
    [{ on: "send" }, { on: "send" }, { on: "interrupt", fail: "The provider lost the turn" }],
    frames,
    { steer: true, prepareInput: leases.prepareInput },
  );
  const id = await h.create();
  const provider = h.contexts[0];
  if (!provider) throw new Error("Missing provider session");
  await provider.onFrame(frames.frame(start));
  await h.engine.flush();
  h.command({
    type: "thread.send",
    threadId: id,
    input: text("steer"),
    context: image,
    delivery: "steer",
  });
  await h.engine.flush();
  expect(leases.held()).toBe(1);
  // The provider can't interrupt: the Stop ends the provider session itself.
  h.command({ type: "thread.interrupt", threadId: id, cascade: true });
  await h.engine.flush();
  expect(leases.held()).toBe(0);
});

test("a steer whose turn ends while its files are prepared is released by the run that reads it", async () => {
  let gate: PromiseWithResolvers<void> | undefined;
  const entered = Promise.withResolvers<void>();
  const leases = files(4, async () => {
    if (!gate) return;
    entered.resolve();
    await gate.promise;
  });
  const { h, id, provider, frames, run } = await idleThread({
    steer: true,
    prepareInput: leases.prepareInput,
  });
  await run(start);
  gate = Promise.withResolvers<void>();
  h.command({
    type: "thread.send",
    threadId: id,
    input: text("late steer"),
    context: image,
    delivery: "steer",
  });
  await entered.promise;
  await provider.onFrame(frames.frame(end));
  gate.resolve();
  await h.engine.flush();
  expect(leases.held()).toBe(1);
  await run(start, end);
  expect(leases.held()).toBe(0);
});
