import { expect, test } from "vitest";
import { Automation, Command, ThreadId } from "@ace/protocol";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { connectAutomations } from "./automation-socket-test-support.ts";
import { commandContext } from "./commands.ts";
import { end } from "./engine/test-support.ts";

const definition = (workspace: string) =>
  Automation.parse({
    id: "one-thread-job",
    title: "One thread job",
    enabled: true,
    workspace,
    provider: "claude",
    prompt: "Check the build",
    worktree: false,
    trigger: { kind: "manual" },
    missedRun: "skip",
    concurrency: 1,
    jitterMs: 0,
  });

type Fixture = Awaited<ReturnType<typeof daemonFixture>>;
/** Real daemon work under a loaded machine can take a few seconds. */
const wait = { timeout: 15_000 };

/**
 * The agent answers its turn with `text`, as its own new message, once the provider has taken
 * that turn's input (its `turn`th), so the turn's start never lands after its end.
 */
async function answer(f: Fixture, thread: ThreadId, turn: number, item: string, text: string) {
  await expect.poll(() => f.h.inputs.get(thread)?.length ?? 0, wait).toBeGreaterThanOrEqual(turn);
  await f.h.emit(
    thread,
    {
      type: "item.upsert",
      agent: "root",
      item,
      draft: {
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text }],
        complete: true,
      },
    },
    end,
  );
  await settle(f);
}

/** Let the daemon act on what just happened: flush its engine and move its clock on. */
async function settle(f: Fixture) {
  await f.daemon.engine?.flush();
  f.h.clock.advance(f.h.clock.now() + 1000);
  await f.daemon.engine?.flush();
}

async function setUp() {
  const f = await daemonFixture();
  const app = await connectAutomations(f, "one-thread");
  await f.daemon.settings.set("automations.enabled", true, { kind: "global" });
  const automation = definition(f.workspace);
  expect(
    await app.ask({
      type: "automation.put",
      requestId: "create",
      automation,
      expectedRevision: null,
    }),
  ).toMatchObject({ ok: true });
  const run = (requestId: string) =>
    app.ask({ type: "automation.run", requestId, id: automation.id, variables: {} });
  const runs = async () =>
    (
      await app.ask({
        type: "automation.inbox",
        requestId: "history",
        automationId: automation.id,
        limit: 50,
      })
    ).inbox?.runs ?? [];
  const threads = () =>
    f.daemon.store.listThreads().filter((thread) => thread.title === "Automation: One thread job");
  return { f, app, automation, run, runs, threads };
}

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
