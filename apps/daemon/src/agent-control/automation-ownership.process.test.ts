import type { Fact } from "@ace/core";
import {
  AgentId,
  Command,
  ThreadId,
  type CommandPayload,
  type McpAttribution,
} from "@ace/protocol";
import { expect, test } from "vitest";
import { commandContext } from "../commands.ts";
import { end } from "../engine/test-support.ts";
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

/** A native subagent of the thread's root, still working. */
const helper: Fact[] = [
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

async function settle(f: Fixture) {
  for (let i = 0; i < 3; i++) {
    await f.h.engine.flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function person(f: Fixture, id: string, payload: CommandPayload) {
  const command = Command.parse({ id, deviceId: "person", payload });
  return f.h.engine.handler.handle(command, commandContext(f.h.store));
}

/** The native helper agent of `thread`, as the tools see it calling. */
function helperCaller(f: Fixture, thread: ThreadId): McpAttribution {
  const agent = Object.values(f.h.store.snapshotThread(thread).agents).find(
    (entry) => entry.origin === "provider_subagent",
  );
  if (!agent) throw new Error("Missing helper");
  return { sessionId: "test-lease", threadId: thread, agentId: AgentId.parse(agent.id) };
}

/** A delegation `caller` asks for, without waiting on it. */
const delegate = (f: Fixture, caller: McpAttribution, requestId: string) =>
  ThreadId.parse(f.h.delegate(caller, requestId).childId);

const working = (f: Fixture, thread: ThreadId) =>
  f.h.store.getThread(thread)?.status.state === "working";

test("a child a run's native helper asks for during a later turn is the run's, not that turn's", async () => {
  const f = await setUp();
  try {
    await f.run("alpha", "alpha-1");
    await expect.poll(() => f.h.inputs.get(f.caller.threadId)?.at(-1)).toBe("Run alpha");
    await f.h.emit(f.caller.threadId, ...helper, end);
    await settle(f);
    // A later turn of the thread starts (typed in the provider's own CLI).
    await f.h.emit(f.caller.threadId, { type: "turn.started", agent: "root", trigger: "user" });
    await settle(f);
    // Alpha's helper delegates now, during that later turn, then finishes; so does the turn.
    const child = delegate(f, helperCaller(f, f.caller.threadId), "helper-child");
    await settle(f);
    await f.h.emit(
      f.caller.threadId,
      { type: "turn.ended", agent: "helper", outcome: "completed" },
      end,
    );
    await settle(f);
    expect(working(f, child)).toBe(true);
    // The child is alpha's: alpha stays open for it, and pausing alpha stops it.
    expect((await f.latest("alpha"))?.status).toBe("running");
    await f.setEnabled("alpha", false);
    await expect.poll(() => f.h.service.journal.get(child)?.phase).not.toBe("running");
    await expect
      .poll(() => f.latest("alpha"))
      .toMatchObject({ status: "failed", result: "Stopped before it finished." });
  } finally {
    await f.close();
  }
});

/** Alpha's turn delegates child C, and C delegates grandchild G. */
async function childAndGrandchild(f: Fixture) {
  await f.run("alpha", "alpha-1");
  await expect.poll(() => f.h.inputs.get(f.caller.threadId)?.at(-1)).toBe("Run alpha");
  const child = delegate(f, f.caller, "alpha-child");
  await settle(f);
  const grandchild = delegate(f, f.h.caller(child), "grandchild");
  await settle(f);
  return { child, grandchild };
}

const sendTo = (f: Fixture, id: string, thread: ThreadId, text: string) =>
  person(f, id, { type: "thread.send", threadId: thread, input: [{ type: "text", text }] });

test("pausing a run cancels a child whose whole subtree is the run's, grandchildren included", async () => {
  const f = await setUp();
  try {
    const { child, grandchild } = await childAndGrandchild(f);
    expect(working(f, grandchild)).toBe(true);
    await f.answer(2, "alpha-answer", "Alpha waits on its child.");
    await f.setEnabled("alpha", false);
    await expect
      .poll(() => f.latest("alpha"))
      .toMatchObject({ status: "failed", result: "Stopped before it finished." });
    expect(working(f, child)).toBe(false);
    expect(working(f, grandchild)).toBe(false);
  } finally {
    await f.close();
  }
});

test("pausing a run leaves a child alone when the person's work is below it, and the run waits", async () => {
  const f = await setUp();
  try {
    const { child, grandchild } = await childAndGrandchild(f);
    await f.h.complete(grandchild, "Grandchild done.");
    await settle(f);
    // The person writes to the grandchild directly: that new work is theirs.
    expect(sendTo(f, "person-to-grandchild", grandchild, "Also this").ok).toBe(true);
    await settle(f);
    expect(working(f, grandchild)).toBe(true);
    await f.answer(2, "alpha-answer", "Alpha waits on its child.");
    await f.setEnabled("alpha", false);
    await settle(f);
    // Nothing of that subtree is stopped for the run, and the run isn't over while it works.
    expect(f.h.service.journal.get(child)?.phase).toBe("running");
    expect(f.h.service.journal.get(grandchild)?.phase).toBe("running");
    expect(working(f, child)).toBe(true);
    expect(working(f, grandchild)).toBe(true);
    expect((await f.latest("alpha"))?.status).toBe("running");
    // The person's own Stop of the child stops everything under it, their work included.
    expect(
      person(f, "person-stops-child", { type: "thread.interrupt", threadId: child, cascade: true })
        .ok,
    ).toBe(true);
    await settle(f);
    expect(working(f, grandchild)).toBe(false);
    expect(f.h.service.journal.get(grandchild)?.phase).not.toBe("running");
    await expect.poll(async () => (await f.latest("alpha"))?.status).toBe("failed");
  } finally {
    await f.close();
  }
});

test("after a pause cancels a run's subtree, the person's message there is refused as after their own Stop", async () => {
  const f = await setUp();
  try {
    const { child, grandchild } = await childAndGrandchild(f);
    await f.h.complete(grandchild, "Grandchild done.");
    await f.answer(2, "alpha-answer", "Alpha waits on its child.");
    await f.setEnabled("alpha", false);
    await expect.poll(async () => (await f.latest("alpha"))?.status).toBe("failed");
    expect(working(f, child)).toBe(false);
    // The person writes to the grandchild of the cancelled child, as after their own Stop.
    const sent = sendTo(f, "person-after-pause", grandchild, "Pick this up");
    await settle(f);
    // Refused up front, as below any child a person's Stop cancelled: no work starts to be lost.
    expect(sent).toMatchObject({ ok: false, error: "cancelled" });
    expect(working(f, grandchild)).toBe(false);
    expect(f.h.inputs.get(grandchild)).not.toContain("Pick this up");
  } finally {
    await f.close();
  }
});

test("a person's Stop of one agent stops what it delegated and leaves the root and its other work", async () => {
  const f = await automationFixture("claude");
  try {
    // The person's own turn: the root delegates one child and starts a helper that delegates another.
    expect(
      person(f, "person-ask", {
        type: "thread.send",
        threadId: f.caller.threadId,
        input: [{ type: "text", text: "Split this up" }],
      }).ok,
    ).toBe(true);
    await expect.poll(() => f.h.inputs.get(f.caller.threadId)?.at(-1)).toBe("Split this up");
    await f.h.emit(f.caller.threadId, ...helper);
    await settle(f);
    const rootChild = delegate(f, f.caller, "root-child");
    const caller = helperCaller(f, f.caller.threadId);
    const helperChild = delegate(f, caller, "helper-child");
    const preparing = f.h.service.reserve(caller, {
      requestId: "helper-prepared",
      task: "Prepare a worktree",
      role: "helper-prepared",
      provider: "claude",
      model: "chosen-model",
      wait: false,
      estimatedLoad: 0,
    });
    await settle(f);
    expect(
      person(f, "person-stops-helper", {
        type: "thread.interrupt",
        threadId: f.caller.threadId,
        agentId: caller.agentId,
        cascade: true,
      }).ok,
    ).toBe(true);
    await settle(f);
    // Everything under the helper stops.
    expect(f.h.service.journal.get(helperChild)?.phase).not.toBe("running");
    expect(working(f, helperChild)).toBe(false);
    expect(f.h.service.journal.reservationOf(preparing.record.childId)).toBeUndefined();
    // The root's turn, its queue and its own child go on.
    expect(f.h.service.journal.get(rootChild)?.phase).toBe("running");
    expect(working(f, rootChild)).toBe(true);
    expect(f.h.engine.queue(f.caller.threadId)).toMatchObject({ paused: false });
    expect(
      Object.values(f.h.store.snapshotThread(f.caller.threadId).runs).some(
        (run) => run.state === "active" && run.agentId === f.caller.agentId,
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});
