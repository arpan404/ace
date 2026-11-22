import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
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
      h.engine.holdCheckout("discard", h.home, async () => {
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
      h.engine.holdCheckout("pull", h.home, async () => {
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
    const hold = h.engine.holdCheckout("discard", h.home, async () => {
      await held.opened;
      return "done";
    });
    expect(
      h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "racing" }] }),
    ).toMatchObject({ ok: true });
    await h.engine.flush();
    expect(sent(h)).toEqual(["first"]);

    held.release();
    expect(await hold).toBe("done");
    await h.engine.flush();
    expect(sent(h)).toEqual(["first", "racing"]);
    expect(h.store.getThread(id)?.status.state).toBe("done");
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
    const id = await h.create("first");
    await mkdir(join(h.home, "packages", "app"), { recursive: true });
    const nested = h.store.createWorkspace(join(h.home, "packages", "app"), "App");
    const held = gate();
    const hold = h.engine.holdCheckout("pull", h.home, () => held.opened);
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
    const hold = h.engine.holdCheckout("pull", h.home, async () => {
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

function noop() {}
