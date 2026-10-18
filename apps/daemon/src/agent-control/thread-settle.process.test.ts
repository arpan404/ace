import { expect, test } from "vitest";
import { AgentControlOperation, type McpAttribution, type ThreadId } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { ThreadOrganizer } from "../thread-organizer.ts";
import { question, start } from "../engine/test-support.ts";
import { setup } from "./test-support.ts";

const signal = () => new AbortController().signal;

/** The port and the auto-settle sweep, driven by hand so each test controls when it runs. */
function harness() {
  const h = setup();
  const port = createAgentControlPort(h.store, h.service);
  const organizer = new ThreadOrganizer(h.store, undefined, h.clock.now, () => () => {});
  const run = (caller: McpAttribution, op: string, threadId: ThreadId) =>
    port.execute(caller, AgentControlOperation.parse({ op, threadId }), signal());
  const organization = (id: ThreadId) => {
    const thread = h.store.getThread(id);
    return {
      settledAt: thread?.settledAt,
      settledReason: thread?.settledReason,
      settleWhenDone: thread?.settleWhenDone,
      archivedAt: thread?.archivedAt,
    };
  };
  /** A thread mid-turn, as an agent's own thread is whenever it calls a tool. */
  const working = async () => {
    const self = await h.parent();
    await h.emit(self.threadId, start);
    return self;
  };
  return {
    h,
    run,
    organization,
    working,
    sweep: () => organizer.sweep(),
    close: () => organizer.close(),
  };
}

test("an agent settling its own thread mid-turn settles it once the turn is done", async () => {
  const { h, run, organization, working, sweep, close } = harness();
  try {
    const self = await working();
    expect(h.store.getThread(self.threadId)?.status.state).toBe("working");
    expect(await run(self, "thread.settle", self.threadId)).toEqual({
      ok: true,
      data: { settled: false, settlesWhenDone: true },
    });
    await sweep();
    expect(organization(self.threadId).settledAt).toBeUndefined();

    await h.complete(self.threadId, "All done");
    await sweep();
    expect(h.store.getThread(self.threadId)?.status.state).toBe("done");
    expect(organization(self.threadId)).toEqual({
      settledAt: expect.any(Number),
      settledReason: "manual",
      settleWhenDone: undefined,
      archivedAt: undefined,
    });
  } finally {
    await close();
  }
});

test("a pending settle is dropped when the thread ends up waiting on the person", async () => {
  const { h, run, organization, working, sweep, close } = harness();
  try {
    const self = await working();
    await run(self, "thread.settle", self.threadId);
    await h.emit(self.threadId, question);
    await sweep();
    expect(h.store.getThread(self.threadId)?.status.state).toBe("needs_you");
    expect(organization(self.threadId)).toMatchObject({
      settledAt: undefined,
      settleWhenDone: undefined,
    });
    expect(await run(self, "thread.settle", self.threadId)).toMatchObject({
      ok: false,
      code: "not_ready",
    });
  } finally {
    await close();
  }
});

test("a finished thread settles at once like the person's Settle, and unsettle brings it back", async () => {
  const { h, run, organization, close } = harness();
  try {
    const self = await h.parent();
    await h.complete(self.threadId, "Finished");
    expect(await run(self, "thread.settle", self.threadId)).toEqual({
      ok: true,
      data: { settled: true },
    });
    expect(organization(self.threadId)).toMatchObject({
      settledAt: expect.any(Number),
      settledReason: "manual",
      archivedAt: undefined,
    });
    expect(await run(self, "thread.unsettle", self.threadId)).toMatchObject({ ok: true });
    expect(organization(self.threadId).settledAt).toBeUndefined();
    // Settling again after an unsettle is a fresh change, not a replay of the first one.
    expect(await run(self, "thread.settle", self.threadId)).toMatchObject({ ok: true });
    expect(organization(self.threadId).settledAt).toEqual(expect.any(Number));
  } finally {
    await close();
  }
});

test("unsettle cancels a settle still waiting for the turn to end", async () => {
  const { h, run, organization, working, sweep, close } = harness();
  try {
    const self = await working();
    await run(self, "thread.settle", self.threadId);
    await run(self, "thread.unsettle", self.threadId);
    await h.complete(self.threadId, "Finished");
    await sweep();
    expect(organization(self.threadId)).toMatchObject({
      settledAt: undefined,
      settleWhenDone: undefined,
    });
  } finally {
    await close();
  }
});

test("an agent cannot settle a thread the person started", async () => {
  const { h, run, organization, close } = harness();
  try {
    const self = await h.parent();
    const other = await h.parent();
    await h.complete(other.threadId, "Finished");
    expect(await run(self, "thread.settle", other.threadId)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(organization(other.threadId).settledAt).toBeUndefined();
  } finally {
    await close();
  }
});
