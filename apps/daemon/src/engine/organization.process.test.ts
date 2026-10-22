import { expect, test } from "vitest";
import type { Fact } from "@ace/core";
import { Command, type ThreadId } from "@ace/protocol";
import { ThreadOrganizer } from "../thread-organizer.ts";
import { harness, scriptFrames, start, end, question, task } from "./test-support.ts";

type Organized = "thread.settle" | "thread.unsettle" | "thread.delete" | "thread.autoSettle";

/** A thread whose first turn ends with `facts`, with a sweepable organizer and a device. */
async function organized(...facts: Fact[]) {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, ...facts)] }], frames);
  const organizer = new ThreadOrganizer(h.store, undefined, h.clock.now, () => () => {});
  const id = await h.create();
  const client = await h.connect("device");
  const command = async (type: Organized, commandId: string) => {
    client.send({
      type: "command",
      command: Command.parse({
        id: commandId,
        deviceId: "device",
        payload: {
          type,
          threadId: id,
          ...(type === "thread.autoSettle" ? { enabled: true } : {}),
        },
      }),
    });
    return client.next();
  };
  const merged = (thread: ThreadId) =>
    h.store.appendEvents(
      thread,
      [
        {
          type: "thread.client.updated",
          changes: { details: { linkedPr: { number: 42, state: "merged" } } },
        },
      ],
      h.clock.now(),
    );
  return {
    h,
    id,
    frames,
    command,
    merged: () => merged(id),
    sweep: () => organizer.sweep(),
    async close() {
      await organizer.close();
      await h.close();
    },
  };
}

test("a merged PR never settles a thread whose question waits on the person, and settling it by hand closes the question", async () => {
  const f = await organized(question);
  try {
    expect(f.h.store.getThread(f.id)?.status.state).toBe("needs_you");
    f.merged();
    await f.sweep();
    expect(f.h.store.getThread(f.id)?.settledAt).toBeUndefined();

    expect(await f.command("thread.settle", "waiting-human")).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.store.getThread(f.id)?.settledReason).toBe("manual");
    expect(f.h.store.getThread(f.id)?.status.state).not.toBe("needs_you");
    expect(f.h.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a thread unsettled by hand stays until auto-settle is back on", async () => {
  const f = await organized(end);
  try {
    expect(await f.command("thread.settle", "settled")).toMatchObject({ ok: true });
    await f.command("thread.unsettle", "unsettled");
    f.merged();
    await f.sweep();
    // Unsettled by hand: the merged PR doesn't settle it again.
    expect(f.h.store.getThread(f.id)?.settledAt).toBeUndefined();
    await f.command("thread.autoSettle", "auto-settle-on");
    await f.sweep();
    expect(f.h.store.getThread(f.id)?.settledReason).toBe("pr_merged");
    expect(f.h.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a merged PR waits for a background shell to finish before it settles the thread", async () => {
  const f = await organized(task, end);
  try {
    expect(f.h.store.getThread(f.id)?.status).toMatchObject({
      state: "waiting",
      on: "background_task",
    });
    expect(await f.command("thread.delete", "running-background")).toMatchObject({
      ok: false,
      error: "thread_busy",
    });
    f.merged();
    await f.sweep();
    expect(f.h.store.getThread(f.id)?.settledAt).toBeUndefined();

    const context = f.h.contexts[0];
    if (!context) throw new Error("Missing provider boundary");
    context.onFrame(
      f.frames.frame({ type: "background.ended", task: "shell", status: "completed" }),
    );
    await f.h.engine.flush();
    await f.sweep();
    expect(f.h.store.getThread(f.id)?.settledReason).toBe("pr_merged");
    expect(await f.command("thread.delete", "completed-tree")).toMatchObject({ ok: true });
    expect(f.h.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
