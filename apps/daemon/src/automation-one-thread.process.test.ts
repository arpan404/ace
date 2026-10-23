import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { commandContext } from "./commands.ts";
import { answer, settle, setUp, wait } from "./automation-one-thread-test-support.ts";

test("every run of an automation is one more turn of its one thread, and keeps the agent's answer", async () => {
  const { f, app, run, runs, threads } = await setUp();
  try {
    await run("first");
    await expect.poll(() => threads().length, wait).toBe(1);
    const thread = ThreadId.parse(threads()[0]?.id);
    await expect.poll(() => f.h.contexts.has(thread), wait).toBe(true);
    await answer(f, thread, 1, "answer-1", "The build is green.");
    await expect
      .poll(async () => (await runs())[0], wait)
      .toMatchObject({ status: "succeeded", result: "The build is green.", threadId: thread });

    await run("second");
    await settle(f);
    await expect
      .poll(() => f.h.inputs.get(thread), wait)
      .toEqual(["Check the build", "Check the build"]);
    await answer(f, thread, 2, "answer-2", "Two tests are flaky.");
    await expect
      .poll(async () => (await runs())[0], wait)
      .toMatchObject({ status: "succeeded", result: "Two tests are flaky.", threadId: thread });
    expect(threads()).toHaveLength(1);
    expect((await runs()).map((entry) => entry.result)).toEqual([
      "Two tests are flaky.",
      "The build is green.",
    ]);
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});

test("a run that fires while the person is mid-turn waits for that turn, then runs", async () => {
  const { f, app, run, runs, threads } = await setUp();
  try {
    await run("first");
    await expect.poll(() => threads().length, wait).toBe(1);
    const thread = ThreadId.parse(threads()[0]?.id);
    await expect.poll(() => f.h.contexts.has(thread), wait).toBe(true);
    await answer(f, thread, 1, "answer-1", "Done once.");
    await expect.poll(async () => (await runs())[0]?.status, wait).toBe("succeeded");

    // The person asks something of their own in the automation's thread.
    const person = Command.parse({
      id: "person-question",
      deviceId: "person",
      payload: { type: "thread.send", threadId: thread, input: [{ type: "text", text: "Why?" }] },
    });
    expect(f.daemon.engine?.handler.handle(person, commandContext(f.daemon.store)).ok).toBe(true);
    await settle(f);
    await expect.poll(() => f.h.inputs.get(thread)?.at(-1), wait).toBe("Why?");

    await run("second");
    await expect.poll(async () => (await runs())[0]?.status, wait).toBe("running");
    // Queued behind the person's turn: not sent until that turn ends.
    expect(f.h.inputs.get(thread)?.at(-1)).toBe("Why?");
    await answer(f, thread, 2, "answer-person", "Because the cache was cold.");
    await expect.poll(() => f.h.inputs.get(thread)?.at(-1), wait).toBe("Check the build");
    expect((await runs())[0]?.status).toBe("running");
    await answer(f, thread, 3, "answer-2", "Done twice.");
    await expect
      .poll(async () => (await runs())[0], wait)
      .toMatchObject({ status: "succeeded", result: "Done twice." });
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});

test("pausing while a run waits behind the person's turn takes it out and leaves their turn going", async () => {
  const { f, app, automation, run, runs, threads } = await setUp();
  try {
    await run("first");
    await expect.poll(() => threads().length, wait).toBe(1);
    const thread = ThreadId.parse(threads()[0]?.id);
    await expect.poll(() => f.h.contexts.has(thread), wait).toBe(true);
    await answer(f, thread, 1, "answer-1", "Done once.");
    await expect.poll(async () => (await runs())[0]?.status, wait).toBe("succeeded");

    const person = Command.parse({
      id: "person-question",
      deviceId: "person",
      payload: { type: "thread.send", threadId: thread, input: [{ type: "text", text: "Why?" }] },
    });
    expect(f.daemon.engine?.handler.handle(person, commandContext(f.daemon.store)).ok).toBe(true);
    await settle(f);
    await run("second");
    await expect.poll(async () => (await runs())[0]?.status, wait).toBe("running");

    await app.ask({
      type: "automation.setEnabled",
      requestId: "pause",
      id: automation.id,
      enabled: false,
    });
    await settle(f);
    await expect
      .poll(async () => (await runs())[0], wait)
      .toMatchObject({ status: "failed", result: "Stopped before it started." });
    expect(f.daemon.store.getThread(thread)?.status.state).toBe("working");
    // The person's turn ends as theirs, and the run's message never reaches the agent.
    await answer(f, thread, 2, "answer-person", "Because the cache was cold.");
    expect(f.h.inputs.get(thread)).toEqual(["Check the build", "Why?"]);
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});

test("pausing during a run's own turn stops that turn", async () => {
  const { f, app, automation, run, runs, threads } = await setUp();
  try {
    await run("first");
    await expect.poll(() => threads().length, wait).toBe(1);
    const thread = ThreadId.parse(threads()[0]?.id);
    await expect.poll(() => f.h.inputs.get(thread)?.length ?? 0, wait).toBe(1);
    await app.ask({
      type: "automation.setEnabled",
      requestId: "pause",
      id: automation.id,
      enabled: false,
    });
    await settle(f);
    await settle(f);
    // The provider ends the stopped turn, as one does after a stop.
    await f.h.emit(thread, { type: "turn.ended", agent: "root", outcome: "interrupted" });
    await settle(f);
    await expect
      .poll(async () => (await runs())[0], wait)
      .toMatchObject({ status: "failed", result: "Stopped before it finished." });
    expect(f.daemon.store.getThread(thread)?.status.state).not.toBe("working");
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});
