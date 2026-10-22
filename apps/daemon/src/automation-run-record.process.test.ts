import { expect, test } from "vitest";
import { z } from "zod";
import { CommandId, ThreadId } from "@ace/protocol";
import {
  answer,
  personCommand,
  personSend,
  settle,
  setUp,
  wait,
} from "./automation-one-thread-test-support.ts";

/** A first run that made the automation's thread and finished in it. */
async function firstRun(context: Awaited<ReturnType<typeof setUp>>) {
  const { f, run, runs, threads } = context;
  await run("first");
  await expect.poll(() => threads().length, wait).toBe(1);
  const thread = ThreadId.parse(threads()[0]?.id);
  await expect.poll(() => f.h.contexts.has(thread), wait).toBe(true);
  await answer(f, thread, 1, "answer-1", "Done once.");
  await expect.poll(async () => (await runs())[0]?.status, wait).toBe("succeeded");
  return thread;
}

test("a run whose queued message the person takes out ends, saying so", async () => {
  const context = await setUp();
  const { f, app, run, runs } = context;
  try {
    const thread = await firstRun(context);
    expect(personSend(f, thread, "person-question", "Why?")?.ok).toBe(true);
    await settle(f);
    await run("second");
    await expect.poll(() => f.daemon.engine?.queue(thread).messages.length, wait).toBe(1);
    const queue = f.daemon.engine?.queue(thread);
    const message = queue?.messages[0];
    if (!queue || !message) throw new Error("Missing queued run");
    const removed = personCommand(f, "person-removes", {
      type: "queue.remove",
      threadId: thread,
      expectedRevision: queue.revision,
      messageId: CommandId.parse(message.id),
    });
    expect(removed?.ok).toBe(true);
    await settle(f);
    await expect
      .poll(async () => (await runs())[0], wait)
      .toMatchObject({ status: "failed", result: "Its message was taken out of the queue." });
    // The person's own turn is untouched.
    expect(f.daemon.store.getThread(thread)?.status.state).toBe("working");
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});

test("a person's Stop still holds the automation's next run until they write again", async () => {
  const context = await setUp();
  const { f, app, run, runs } = context;
  try {
    const thread = await firstRun(context);
    const stop = personCommand(f, "person-stop", {
      type: "thread.interrupt",
      threadId: thread,
      cascade: true,
    });
    expect(stop?.ok).toBe(true);
    await settle(f);
    await run("held");
    await expect.poll(async () => (await runs())[0]?.status, wait).toBe("failed");
    expect(f.h.inputs.get(thread)).toEqual(["Check the build"]);
    // Their next message lets the automation's runs in again.
    expect(personSend(f, thread, "person-again", "Carry on")?.ok).toBe(true);
    await answer(f, thread, 2, "answer-person", "Carrying on.");
    await run("after");
    await expect.poll(() => f.h.inputs.get(thread)?.at(-1), wait).toBe("Check the build");
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});

test("pausing a run stops the threads its turn delegated to before the run settles", async () => {
  const context = await setUp();
  const { f, app, automation, run, runs, threads } = context;
  try {
    await run("first");
    await expect.poll(() => threads().length, wait).toBe(1);
    const thread = ThreadId.parse(threads()[0]?.id);
    await expect.poll(() => f.h.inputs.get(thread)?.length ?? 0, wait).toBe(1);
    const rootAgentId = f.daemon.store.getThread(thread)?.rootAgentId;
    if (!rootAgentId) throw new Error("Missing root agent");
    const delegated = await f.controls.port.execute(
      { sessionId: "test", threadId: thread, agentId: rootAgentId },
      {
        op: "delegate_task",
        requestId: "run-child",
        task: "Keep working",
        role: "run-child",
        provider: "claude",
        wait: false,
        estimatedLoad: 0,
      },
      new AbortController().signal,
    );
    const child = z.object({ data: z.object({ threadId: ThreadId }) }).parse(delegated)
      .data.threadId;
    await settle(f);
    expect(f.daemon.store.getThread(child)?.status.state).toBe("working");
    await app.ask({
      type: "automation.setEnabled",
      requestId: "pause",
      id: automation.id,
      enabled: false,
    });
    await settle(f);
    await expect
      .poll(async () => (await runs())[0], wait)
      .toMatchObject({ status: "failed", result: "Stopped before it finished." });
    await settle(f);
    // Nothing the run began is left working once it reads as stopped, nor starts again.
    expect(f.daemon.store.getThread(thread)?.status.state).not.toBe("working");
    expect(f.daemon.store.getThread(child)?.status.state).not.toBe("working");
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});
