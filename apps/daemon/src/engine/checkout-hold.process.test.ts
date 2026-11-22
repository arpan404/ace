import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { harness, scriptFrames, start, end, task } from "./test-support.ts";

// A source control change (discard, switch, pull, stash) rewrites files under every thread bound
// to the checkout, so it holds the whole checkout: no agent may run or start while it works.

async function peerThread(h: Awaited<ReturnType<typeof harness>>) {
  const result = h.command({
    type: "thread.create",
    threadId: ThreadId.parse("peer"),
    workspaceId: h.workspace,
    provider: "codex",
    input: [{ type: "text", text: "peer" }],
  });
  if (!result.threadId) throw new Error("Peer creation failed");
  await h.engine.flush();
  return result.threadId;
}

test("a live peer in the same checkout refuses the hold before any Git effect", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  try {
    const first = await h.create();
    const peer = await peerThread(h);
    h.command({ type: "thread.send", threadId: peer, input: [{ type: "text", text: "hold" }] });
    let ran = false;
    await expect(
      h.engine.holdCheckout(first, "discard", h.store.executionWorkspace(first).path, async () => {
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
    const id = await h.create();
    let ran = false;
    await expect(
      h.engine.holdCheckout(id, "pull", h.store.executionWorkspace(id).path, async () => {
        ran = true;
      }),
    ).rejects.toThrow("agent_working");
    expect(ran).toBe(false);
  } finally {
    await h.close();
  }
});

test("while held, no thread in the checkout admits a send; afterwards sends run", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  try {
    const id = await h.create();
    const peer = await peerThread(h);
    let release = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const hold = h.engine.holdCheckout(
      id,
      "discard",
      h.store.executionWorkspace(id).path,
      async () => {
        held = true;
        await gate;
        return "done";
      },
    );
    await Promise.resolve();
    expect(held).toBe(true);
    for (const threadId of [id, peer])
      expect(
        h.command({ type: "thread.send", threadId, input: [{ type: "text", text: "racing" }] }),
      ).toMatchObject({ ok: false });
    release();
    expect(await hold).toBe("done");
    expect(
      h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "next" }] }),
    ).toMatchObject({ ok: true });
    await h.engine.flush();
    expect(h.store.getThread(id)?.status.state).toBe("done");
  } finally {
    await h.close();
  }
});

test("a failed Git effect releases the hold", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  try {
    const id = await h.create();
    await expect(
      h.engine.holdCheckout(id, "pull", h.store.executionWorkspace(id).path, async () => {
        throw new Error("git_failed");
      }),
    ).rejects.toThrow("git_failed");
    expect(
      h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "next" }] }),
    ).toMatchObject({ ok: true });
  } finally {
    await h.close();
  }
});

function noop() {}
