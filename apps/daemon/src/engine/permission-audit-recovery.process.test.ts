import { expect, test } from "vitest";
import { Engine, Store } from "@ace/daemon";
import type { Fact } from "@ace/core";
import { harness, scriptFrames, start, end } from "./test-support.ts";

function approval(command: string): Fact {
  return {
    type: "interaction.opened",
    agent: "root",
    interaction: "permission",
    blocking: true,
    request: {
      kind: "approval",
      title: command,
      target: { tool: "shell", command, access: "execute" },
      options: [
        { id: "once", label: "Once", kind: "allow_once" },
        { id: "no", label: "Deny", kind: "deny" },
      ],
    },
  };
}

test.each(["pwd", "curl example.com"])(
  "a cold store reopen retains the exact review and resolution for %s",
  async (command) => {
    const frames = scriptFrames();
    const request = approval(command);
    const h = await harness(
      [
        { on: "send", frames: [frames.frame(start, request)] },
        { on: "resolve", frames: [frames.frame(end)] },
      ],
      frames,
    );
    let reopened: Store | undefined;
    let engine: Engine | undefined;
    try {
      const id = await h.create();
      const original = Object.values(h.store.snapshotThread(id).interactions)[0];
      if (!original?.review) throw new Error("Missing review");
      const review = original.review;
      await h.engine.close();
      await h.store.close();
      reopened = new Store(h.path);
      engine = new Engine(reopened, { registry: h.registry, clock: h.clock });
      const restored = Object.values(reopened.snapshotThread(id).interactions)[0];
      expect(restored?.review).toEqual(original.review);
      expect(restored?.id).toBe(original.id);
      const snapshot = reopened.snapshotThread(id);
      expect(Object.values(snapshot.interactions)).toHaveLength(1);
      expect(Object.values(snapshot.interactions)[0]).toMatchObject({
        id: original.id,
        review: original.review,
      });
      expect(
        Object.values(snapshot.items).filter(
          (item) =>
            item.type === "notice" && item.text.startsWith(`Permission review ${review.decision}:`),
        ),
      ).toHaveLength(1);
      const decisions = reopened
        .readEvents({ afterSeq: 0, threadId: id, limit: 1000 })
        .filter((event) => event.payload.type === "permission.reviewed");
      expect(decisions).toHaveLength(1);
      expect(Object.values(snapshot.interactions)[0]?.resolution).toEqual(original.resolution);
      expect(h.adapter.commands.filter((entry) => entry.type === "resolve")).toHaveLength(
        command === "pwd" ? 1 : 0,
      );
    } finally {
      await engine?.close();
      await reopened?.close();
      await h.close();
    }
  },
);

test("a human answer racing an automatic decision cannot replace its reserved one-shot answer", async () => {
  const frames = scriptFrames();
  const release = Promise.withResolvers<void>();
  const reviewed = Promise.withResolvers<void>();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, approval("pwd"))] },
      { on: "resolve", frames: [frames.frame(end)] },
    ],
    frames,
    { resolveGate: release.promise },
  );
  const stop = h.store.subscribe((events) => {
    if (events.some((event) => event.payload.type === "permission.reviewed")) reviewed.resolve();
  });
  const creating = h.create();
  try {
    await reviewed.promise;
    const id = h.store.listThreads()[0]?.id;
    if (!id) throw new Error("Missing thread");
    const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
    if (!interaction) throw new Error("Missing interaction");
    expect(
      h.command(
        {
          type: "interaction.resolve",
          interactionId: interaction.id,
          resolution: { kind: "approval", optionId: "no" },
        },
        "human",
      ),
    ).toMatchObject({ ok: false, error: "already_resolved" });
    release.resolve();
    await creating;
    expect(Object.values(h.store.snapshotThread(id).interactions)[0]?.resolution).toMatchObject({
      optionId: "once",
    });
    expect(h.adapter.commands.filter((entry) => entry.type === "resolve")).toHaveLength(1);
    expect(
      h.store
        .readEvents({ afterSeq: 0, threadId: id, limit: 1000 })
        .filter((event) => event.payload.type === "permission.reviewed"),
    ).toHaveLength(1);
  } finally {
    stop();
    release.resolve();
    await creating;
    await h.close();
  }
});

test("duplicate pending provider approvals retain one review and one needs-you interaction", async () => {
  const frames = scriptFrames();
  const request = approval("curl example.com");
  const h = await harness(
    [{ on: "send", frames: [frames.frame(start, request, request)] }],
    frames,
  );
  try {
    const id = await h.create();
    const original = Object.values(h.store.snapshotThread(id).interactions)[0];
    h.contexts[0]?.onFrame(frames.frame(request));
    await h.engine.flush();
    expect(Object.values(h.store.snapshotThread(id).interactions)).toEqual([original]);
    expect(
      h.store
        .readEvents({ afterSeq: 0, threadId: id, limit: 1000 })
        .filter((event) => event.payload.type === "permission.reviewed"),
    ).toHaveLength(1);
    expect(h.store.getThread(id)?.status.state).toBe("needs_you");
    expect(h.adapter.commands.filter((entry) => entry.type === "resolve")).toEqual([]);
  } finally {
    await h.close();
  }
});
