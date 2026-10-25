import { expect, test, vi } from "vitest";
import { z } from "zod";
import { MonitorSnapshot, ThreadId } from "@ace/protocol";
import { daemonFixture } from "./daemon-test-support.ts";

type Fixture = Awaited<ReturnType<typeof daemonFixture>>;

async function withDaemon(run: (f: Fixture) => Promise<void>) {
  const f = await daemonFixture();
  try {
    await run(f);
  } finally {
    await f.daemon.close();
  }
}
async function spawn(f: Fixture, name: string) {
  const result = await f.call({
    op: "delegate_task",
    requestId: name,
    provider: "claude",
    task: `Do ${name}`,
    role: `do-${name}`,
    wait: false,
  });
  await f.daemon.engine?.flush();
  return z.object({ threadId: ThreadId }).parse(result.data).threadId;
}
/** How many of the parent's children agents_status reports working and queued. */
async function counts(f: Fixture) {
  await f.daemon.engine?.flush();
  const { children } = MonitorSnapshot.parse((await f.call({ op: "agents.status" })).data);
  const count = (state: string) => children.filter((child) => child.state === state).length;
  return { working: count("working"), queued: count("queued") };
}
const setLimit = (f: Fixture, value: number | null) =>
  f.daemon.settings.set("agents.maxRunningChildren", value, { kind: "global" });

test("with no limit set, every child a parent delegates starts at once", async () => {
  await withDaemon(async (f) => {
    for (let index = 0; index < 6; index++) await spawn(f, `free-${index}`);
    expect(await counts(f)).toMatchObject({ working: 6, queued: 0 });
  });
});

test("a limit set in Settings queues extra children, and raising or clearing it starts them without a restart", async () => {
  await withDaemon(async (f) => {
    await setLimit(f, 1);
    const first = await spawn(f, "first");
    const second = await spawn(f, "second");
    const third = await spawn(f, "third");
    expect(await counts(f)).toMatchObject({ working: 1, queued: 2 });
    expect(f.daemon.store.getThread(first)?.queuedLaunch).toBeUndefined();
    expect(f.daemon.store.getThread(third)?.queuedLaunch?.text).toBe("Do third");
    // A queued child keeps its parent open.
    expect(f.daemon.store.getThread(f.caller.threadId)?.status.state).not.toBe("done");

    await setLimit(f, 2);
    await vi.waitFor(async () => expect(await counts(f)).toMatchObject({ working: 2, queued: 1 }));
    // Oldest first: the second child took the freed slot.
    expect(f.daemon.store.getThread(second)?.queuedLaunch).toBeUndefined();

    await setLimit(f, null);
    await vi.waitFor(async () => expect(await counts(f)).toMatchObject({ working: 3, queued: 0 }));
    expect(f.daemon.store.getThread(third)?.queuedLaunch).toBeUndefined();
  });
});

test("lowering the limit holds back later children but never stops running ones", async () => {
  await withDaemon(async (f) => {
    await spawn(f, "a");
    await spawn(f, "b");
    await setLimit(f, 1);
    await spawn(f, "c");
    expect(await counts(f)).toMatchObject({ working: 2, queued: 1 });
  });
});
