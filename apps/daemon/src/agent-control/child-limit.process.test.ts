import { expect, test, vi } from "vitest";
import { z } from "zod";
import { MonitorSnapshot, ThreadId } from "@ace/protocol";
import { end } from "../engine/test-support.ts";
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
async function spawn(f: Fixture, name: string, provider: "claude" | "codex" = "claude") {
  const result = await f.call({
    op: "delegate_task",
    requestId: name,
    provider,
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

test("a queued child that can no longer start does not hold back the child queued behind it", async () => {
  await withDaemon(async (f) => {
    await setLimit(f, 1);
    const first = await spawn(f, "first-running");
    const refused = await spawn(f, "refused-ahead");
    const behind = await spawn(f, "behind", "codex");
    expect(await counts(f)).toMatchObject({ working: 1, queued: 2 });
    // Claude is turned off: the child first in line can never start, the codex one behind can.
    await f.daemon.settings.set(
      "providers.configuration",
      [{ provider: "claude", enabled: false }],
      {
        kind: "global",
      },
    );
    await vi.waitFor(() =>
      expect((f.h.inputs.get(first) ?? []).join("\n")).toContain("Do first-running"),
    );
    f.h.contexts.get(first)?.onFrame(
      f.h.frames.frame(
        {
          type: "item.upsert",
          agent: "root",
          item: "first-result",
          draft: {
            type: "message",
            role: "assistant",
            parts: [{ type: "text", text: "done" }],
            complete: true,
          },
        },
        end,
      ),
    );
    await f.daemon.engine?.flush();

    await vi.waitFor(() =>
      expect((f.h.inputs.get(behind) ?? []).join("\n")).toContain("Do behind"),
    );
    const { children } = MonitorSnapshot.parse((await f.call({ op: "agents.status" })).data);
    expect(children.find((child) => child.id === refused)?.state).toBe("failed");
  });
});

test("while new work is paused a queued child stays queued after a slot frees, and starts on resume", async () => {
  await withDaemon(async (f) => {
    await setLimit(f, 1);
    const first = await spawn(f, "first-before-pause");
    const held = await spawn(f, "held-by-pause");
    expect(await counts(f)).toMatchObject({ working: 1, queued: 1 });
    await vi.waitFor(() =>
      expect((f.h.inputs.get(first) ?? []).join("\n")).toContain("Do first-before-pause"),
    );
    f.daemon.maintenance.enter("user");
    // Running work finishes while paused.
    f.h.contexts.get(first)?.onFrame(
      f.h.frames.frame(
        {
          type: "item.upsert",
          agent: "root",
          item: "first-result",
          draft: {
            type: "message",
            role: "assistant",
            parts: [{ type: "text", text: "done" }],
            complete: true,
          },
        },
        end,
      ),
    );
    await vi.waitFor(async () => expect(await counts(f)).toMatchObject({ working: 0, queued: 1 }));
    // A retry while paused still leaves it waiting.
    f.h.clock.advance(f.h.clock.now() + 1_000);
    await f.daemon.engine?.flush();
    expect(await counts(f)).toMatchObject({ working: 0, queued: 1 });
    // The held child never reads as finished, and neither does the parent waiting on it.
    expect(f.daemon.store.getThread(held)?.queuedLaunch?.text).toBe("Do held-by-pause");
    expect(f.daemon.store.getThread(held)?.status.state).not.toBe("done");
    expect(f.daemon.store.getThread(f.caller.threadId)?.status.state).not.toBe("done");
    expect(f.h.inputs.get(held)).toBeUndefined();

    f.daemon.maintenance.leave("user");
    // Queued children are retried each second.
    f.h.clock.advance(f.h.clock.now() + 1_000);
    await vi.waitFor(() =>
      expect((f.h.inputs.get(held) ?? []).join("\n")).toContain("Do held-by-pause"),
    );
  });
});
