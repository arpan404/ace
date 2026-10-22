import type { Fact } from "@ace/core";
import { Command, ThreadId, type CommandPayload } from "@ace/protocol";
import { expect, test } from "vitest";
import { commandContext } from "../commands.ts";
import { end, start } from "../engine/test-support.ts";
import { automationFixture } from "./automation-test-support.ts";

type Fixture = Awaited<ReturnType<typeof automationFixture>>;

async function setUp() {
  const f = await automationFixture("claude");
  await f.save("alpha", "Run alpha");
  await f.save("beta", "Run beta");
  await f.settings.set("automations.enabled", true, { kind: "global" });
  await f.settings.settled({ kind: "global" });
  return f;
}

/** A native subagent the root starts, still working. */
const subagent: Fact[] = [
  {
    type: "agent.seen",
    agent: "helper",
    parent: "root",
    origin: "provider_subagent",
    fidelity: "full",
    native: { provider: "claude", nativeId: "helper-native" },
    cwd: "/repo",
  },
  { type: "turn.started", agent: "helper", trigger: "spawn" },
];

const shell = (agent: string, task: string): Fact => ({
  type: "background.started",
  agent,
  task,
  kind: "shell",
  title: "Background build",
  stoppable: true,
});

async function alphaTurn(f: Fixture) {
  await f.run("alpha", "alpha-1");
  await expect.poll(() => f.h.inputs.get(f.caller.threadId)?.at(-1)).toBe("Run alpha");
  await f.h.engine.flush();
}

async function settle(f: Fixture) {
  for (let i = 0; i < 3; i++) {
    await f.h.engine.flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** A command from the person's own device. */
function person(f: Fixture, id: string, payload: CommandPayload) {
  const command = Command.parse({ id, deviceId: "person", payload });
  return f.h.engine.handler.handle(command, commandContext(f.h.store));
}

const say = (f: Fixture, id: string, text: string, thread = f.caller.threadId) =>
  person(f, id, { type: "thread.send", threadId: thread, input: [{ type: "text", text }] });

const runs = (f: Fixture) => Object.values(f.h.store.snapshotThread(f.caller.threadId).runs);

test("pausing a run stops its leftover subagent without touching the person's turn or queue", async () => {
  const f = await setUp();
  try {
    await alphaTurn(f);
    await f.h.emit(f.caller.threadId, ...subagent, end);
    await settle(f);
    // The person's own turn starts, and they queue one more message behind it.
    expect(say(f, "person-ask", "Why?").ok).toBe(true);
    await expect.poll(() => f.h.inputs.get(f.caller.threadId)?.at(-1)).toBe("Why?");
    expect(say(f, "person-next", "And then?").ok).toBe(true);
    await settle(f);
    expect(f.h.engine.queue(f.caller.threadId).messages).toHaveLength(1);
    await f.setEnabled("alpha", false);
    await expect
      .poll(() => f.latest("alpha"))
      .toMatchObject({ status: "failed", result: "Stopped before it finished." });
    // Only the subagent was stopped: the person's turn, their input and queue carry on.
    const thread = f.h.store.snapshotThread(f.caller.threadId);
    const ask = Object.values(thread.items).find((item) => item.id === "input:person-ask");
    expect(ask && "notAnswered" in ask ? ask.notAnswered : undefined).toBeUndefined();
    expect(runs(f).filter((run) => run.state === "active")).toHaveLength(1);
    expect(f.h.engine.queue(f.caller.threadId)).toMatchObject({ paused: false });
    expect(f.h.engine.queue(f.caller.threadId).messages).toHaveLength(1);
    expect(f.h.store.getThread(f.caller.threadId)?.status.state).toBe("working");
  } finally {
    await f.close();
  }
});

test("a subagent the run started keeps it open when it starts background work after the next turn began", async () => {
  const f = await setUp();
  try {
    await alphaTurn(f);
    await f.h.emit(f.caller.threadId, ...subagent, end);
    await settle(f);
    expect(say(f, "person-ask", "Something else").ok).toBe(true);
    await expect.poll(() => f.h.inputs.get(f.caller.threadId)?.at(-1)).toBe("Something else");
    // Now, in the person's turn, alpha's subagent starts a shell and finishes its own turn.
    await f.h.emit(f.caller.threadId, shell("helper", "late-shell"), {
      type: "turn.ended",
      agent: "helper",
      outcome: "completed",
    });
    await settle(f);
    expect((await f.latest("alpha"))?.status).toBe("running");
    await f.h.emit(f.caller.threadId, {
      type: "background.ended",
      task: "late-shell",
      status: "completed",
    });
    await expect.poll(async () => (await f.latest("alpha"))?.status).toBe("succeeded");
  } finally {
    await f.close();
  }
});

test("a stop of leftover work that fails to reach the provider is sent again until it does", async () => {
  const f = await setUp();
  try {
    await alphaTurn(f);
    await f.h.emit(f.caller.threadId, shell("root", "shell"), end);
    await settle(f);
    f.h.failNextTaskStops(1);
    await f.setEnabled("alpha", false);
    await settle(f);
    expect(f.h.stoppedTasks).toEqual([]);
    expect((await f.latest("alpha"))?.status).toBe("running");
    // The run notices the lost stop on its next check and sends it again after a backoff.
    for (let i = 0; i < 4 && !f.h.stoppedTasks.length; i++) {
      f.h.clock.advance(f.h.clock.now() + 5_000);
      await settle(f);
    }
    expect(f.h.stoppedTasks).toEqual(["shell"]);
    await expect
      .poll(() => f.latest("alpha"))
      .toMatchObject({ status: "failed", result: "Stopped before it finished." });
  } finally {
    await f.close();
  }
});

test("a child the person reopens is theirs, and a native revival keeps its first owner", async () => {
  const f = await setUp();
  try {
    await alphaTurn(f);
    const child = ThreadId.parse(f.h.delegate(f.caller, "helper").childId);
    await settle(f);
    await f.h.complete(child, "Helped.");
    await f.answer(2, "alpha-answer", "Alpha done.");
    await expect.poll(async () => (await f.latest("alpha"))?.status).toBe("succeeded");
    // Beta's turn runs while the person writes to the child themselves.
    await f.run("beta", "beta-1");
    await expect.poll(() => f.h.inputs.get(f.caller.threadId)?.at(-1)).toBe("Run beta");
    expect(say(f, "person-to-child", "Look at this too", child).ok).toBe(true);
    await settle(f);
    expect(f.h.store.getThread(child)?.status.state).toBe("working");
    await f.answer(3, "beta-answer", "Beta done.");
    // The person's work in the child is not beta's: beta is done, and nothing stopped the child.
    await expect
      .poll(() => f.latest("beta"))
      .toMatchObject({ status: "succeeded", result: "Beta done." });
    expect(f.h.store.getThread(child)?.status.state).toBe("working");
    await f.h.complete(child, "Looked.");
    await settle(f);
    // The child carries on by itself during another turn of beta: still alpha's helper, not beta's.
    await f.run("beta", "beta-2");
    await expect.poll(() => f.h.inputs.get(f.caller.threadId)).toHaveLength(4);
    await f.h.emit(child, start);
    await settle(f);
    expect(f.h.store.getThread(child)?.status.state).toBe("working");
    await f.answer(4, "beta-answer-2", "Beta again.");
    await expect
      .poll(() => f.latest("beta"))
      .toMatchObject({ status: "succeeded", result: "Beta again." });
  } finally {
    await f.close();
  }
});
