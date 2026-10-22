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

test("pausing a run stops its child but not work the person reopened under that child", async () => {
  const f = await setUp();
  try {
    await f.run("alpha", "alpha-1");
    await expect.poll(() => f.h.inputs.get(f.caller.threadId)?.at(-1)).toBe("Run alpha");
    const child = delegate(f, f.caller, "alpha-child");
    await settle(f);
    const grandchild = delegate(f, f.h.caller(child), "grandchild");
    await settle(f);
    await f.h.complete(grandchild, "Grandchild done.");
    await settle(f);
    // The person writes to the grandchild directly: that new work is theirs.
    expect(
      person(f, "person-to-grandchild", {
        type: "thread.send",
        threadId: grandchild,
        input: [{ type: "text", text: "Also this" }],
      }).ok,
    ).toBe(true);
    await settle(f);
    expect(working(f, grandchild)).toBe(true);
    await f.setEnabled("alpha", false);
    await expect.poll(() => f.h.service.journal.get(child)?.phase).not.toBe("running");
    await settle(f);
    // The child's own turn stopped; the person's work below it goes on.
    expect(
      Object.values(f.h.store.snapshotThread(child).runs).every((run) => run.state !== "active"),
    ).toBe(true);
    expect(f.h.service.journal.get(grandchild)?.phase).toBe("running");
    expect(working(f, grandchild)).toBe(true);
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
