import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { checkoutHoldDeadlineMs, checkoutHoldPollMs } from "./checkout-hold.ts";
import { Engine } from "./index.ts";
import { harness, scriptFrames, start, end, task } from "./test-support.ts";

// A source control change (discard, switch, pull, stash) rewrites files in one Git worktree. It
// holds that worktree: no agent may be running there when it starts, and nothing new runs there
// (a send, queued work, a new thread, a session opening) until it ends. Nothing the person sends
// is refused or lost: it waits, then reaches the provider once.

type Harness = Awaited<ReturnType<typeof harness>>;

async function peerThread(h: Harness, workspaceId = h.workspace, id = "peer") {
  const result = h.command({
    type: "thread.create",
    threadId: ThreadId.parse(id),
    workspaceId,
    provider: "codex",
    input: [{ type: "text", text: id }],
  });
  if (!result.threadId) throw new Error("Peer creation failed");
  await h.engine.flush();
  return result.threadId;
}

/** Hold the harness's worktree for `commandId`, asked from `threadId`. */
function holdWorktree<T>(
  h: Harness,
  threadId: ThreadId,
  commandId: string,
  effect: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return h.engine.holdCheckout({ threadId, commandId, top: h.home, effect });
}

/** The thread asking for the hold: the first one the harness made. */
function anyThread(h: Harness): ThreadId {
  const thread = h.store.listThreads().at(-1);
  if (!thread) throw new Error("No thread");
  return thread.id;
}

/** Texts the provider received, in order. */
function sent(h: Harness): string[] {
  return h.adapter.commands.flatMap((command) =>
    command.type === "send"
      ? command.input.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );
}

function gate() {
  let release = noop;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

test("a thread mid-turn in the worktree refuses the hold before any Git effect", async () => {
  const frames = scriptFrames();
  // The turn starts and keeps going.
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  try {
    const id = await h.create();
    expect(h.store.getThread(id)?.status.state).toBe("working");
    let ran = false;
    await expect(
      holdWorktree(h, anyThread(h), "discard", async () => {
        ran = true;
      }),
    ).rejects.toThrow("agent_working");
    expect(ran).toBe(false);
  } finally {
    await h.close();
  }
});

test("background work left running refuses the hold", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, task, end)] }], frames);
  try {
    await h.create();
    let ran = false;
    await expect(
      holdWorktree(h, anyThread(h), "pull", async () => {
        ran = true;
      }),
    ).rejects.toThrow("agent_working");
    expect(ran).toBe(false);
  } finally {
    await h.close();
  }
});

test("a message sent during the hold is accepted, waits, and reaches the provider once", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  try {
    const id = await h.create("first");
    const held = gate();
    const hold = holdWorktree(h, anyThread(h), "discard", async () => {
      await held.opened;
      return "done";
    });
    expect(
      h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "racing" }] }),
    ).toMatchObject({ ok: true });
    await h.engine.flush();
    expect(sent(h)).toEqual(["first"]);
    // Waiting on the queue: never done, never shown as running, and it says Git is busy.
    expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "queue" });
    expect(h.store.getThread(id)?.details?.gitBusy).toBeDefined();

    held.release();
    expect(await hold).toBe("done");
    await h.engine.flush();
    expect(sent(h)).toEqual(["first", "racing"]);
    expect(h.store.getThread(id)?.status.state).toBe("done");
    expect(h.store.getThread(id)?.details?.gitBusy).toBeUndefined();
  } finally {
    await h.close();
  }
});

test("a thread created in the worktree, or in a folder inside it, starts only after the hold", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  try {
    await h.create("first");
    await mkdir(join(h.home, "packages", "app"), { recursive: true });
    const nested = h.store.createWorkspace(join(h.home, "packages", "app"), "App");
    const held = gate();
    const hold = holdWorktree(h, anyThread(h), "pull", () => held.opened);
    await peerThread(h, h.workspace, "same-root");
    await peerThread(h, nested, "in-a-folder");
    await h.engine.flush();
    expect(sent(h)).toEqual(["first"]);
    expect(h.contexts).toHaveLength(1);

    held.release();
    await hold;
    await h.engine.flush();
    expect(sent(h).toSorted()).toEqual(["first", "in-a-folder", "same-root"]);
  } finally {
    await h.close();
  }
});

test("a failed Git effect releases the hold and what waited runs", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  try {
    const id = await h.create("first");
    const held = gate();
    const hold = holdWorktree(h, anyThread(h), "pull", async () => {
      await held.opened;
      throw new Error("git_failed");
    });
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "next" }] });
    held.release();
    await expect(hold).rejects.toThrow("git_failed");
    await h.engine.flush();
    expect(sent(h)).toEqual(["first", "next"]);
  } finally {
    await h.close();
  }
});

test("a hold past its deadline cancels the Git work, waits for it to stop, then releases", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  try {
    const id = await h.create("first");
    let cancelled = false;
    const hold = holdWorktree(
      h,
      id,
      "pull",
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            cancelled = true;
            reject(new Error("git_cancelled"));
          });
        }),
    );
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "later" }] });
    const startedAt = h.clock.time;
    h.clock.advance(startedAt + checkoutHoldDeadlineMs - 1);
    await h.engine.flush();
    expect(cancelled).toBe(false);
    expect(sent(h)).toEqual(["first"]);
    h.clock.advance(startedAt + checkoutHoldDeadlineMs);
    await expect(hold).rejects.toThrow("git_cancelled");
    expect(cancelled).toBe(true);
    await h.engine.flush();
    expect(sent(h)).toEqual(["first", "later"]);
  } finally {
    await h.close();
  }
});

test("after a crash mid-hold, the worktree stays held until Git's lock is gone, then queued work runs", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  let restarted: Engine | undefined;
  try {
    const id = await h.create("first");
    // The daemon died while a pull it held still had Git writing the index.
    await mkdir(join(h.home, ".git"), { recursive: true });
    const lock = join(h.home, ".git", "index.lock");
    await writeFile(lock, "");
    h.store.appendEvents(
      id,
      [
        {
          type: "thread.client.updated",
          changes: {
            details: { ...h.store.getThread(id)?.details, gitBusy: { since: h.clock.time } },
          },
        },
      ],
      h.clock.time,
    );
    h.store.workspaceReservations.recordCheckoutHold(h.home, "crashed-pull", h.clock.time, [id]);
    await h.engine.close();

    const engine = new Engine(h.store, { registry: h.registry, clock: h.clock, idleMs: 30_000 });
    restarted = engine;
    const send = (text: string) => {
      const command = Command.parse({
        id: randomUUID(),
        deviceId: "device",
        payload: { type: "thread.send", threadId: id, input: [{ type: "text", text }] },
      });
      return h.store.recordCommand(command.id, command.deviceId, () =>
        engine.handler.handle(command, h.store),
      );
    };
    expect(send("after restart")).toMatchObject({ ok: true });
    await engine.flush();
    expect(sent(h)).toEqual(["first"]);

    // Git finished: the next look finds no lock, the hold lifts and the message goes, once.
    await rm(lock);
    h.clock.advance(h.clock.time + checkoutHoldPollMs);
    await engine.flush();
    expect(sent(h)).toEqual(["first", "after restart"]);
    // The mark the crashed hold left on the thread is gone with it.
    expect(h.store.getThread(id)?.details?.gitBusy).toBeUndefined();
    expect(h.store.workspaceReservations.checkoutHolds()).toEqual([]);
  } finally {
    await restarted?.close();
    await h.close();
  }
});

test("a lock a crashed hold left behind never holds the worktree past the deadline", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  let restarted: Engine | undefined;
  try {
    await h.create("first");
    await mkdir(join(h.home, ".git"), { recursive: true });
    await writeFile(join(h.home, ".git", "index.lock"), "");
    h.store.workspaceReservations.recordCheckoutHold(h.home, "crashed-pull", h.clock.time, []);
    await h.engine.close();
    restarted = new Engine(h.store, { registry: h.registry, clock: h.clock, idleMs: 30_000 });
    expect(h.store.workspaceReservations.checkoutHolds()).toHaveLength(1);
    h.clock.advance(h.clock.time + checkoutHoldDeadlineMs + checkoutHoldPollMs);
    expect(h.store.workspaceReservations.checkoutHolds()).toEqual([]);
  } finally {
    await restarted?.close();
    await h.close();
  }
});

function noop() {}
