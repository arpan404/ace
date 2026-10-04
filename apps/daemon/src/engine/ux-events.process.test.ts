import { afterEach, expect, test } from "vitest";
import { transitionHarness } from "./transition-test-support.ts";
import { harness, scriptFrames, start } from "./test-support.ts";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});
test("a provider handoff is a separate synthetic item before the person's next message", async () => {
  const h = transitionHarness();
  closes.push(h.close);
  const id = await h.create();
  h.command({
    type: "thread.switch",
    threadId: id,
    selection: { provider: "claude", model: "new-model" },
  });
  await h.engine.flush();
  const receipt = h.command({
    type: "thread.send",
    threadId: id,
    input: [{ type: "text", text: "my next message" }],
  });
  await h.engine.flush();
  const view = h.store.snapshotThread(id);
  const items = view.itemOrder.map((id) => view.items[id]);
  const handoff = items.find((item) => item?.type === "message" && item.origin?.kind === "handoff");
  const person = items.find((item) => item?.id === `input:${receipt.commandId}`);
  expect(handoff).toMatchObject({
    synthetic: true,
    origin: {
      kind: "handoff",
      from: { provider: "codex" },
      to: { provider: "claude", model: "new-model" },
      lossy: true,
    },
  });
  expect(person).toMatchObject({
    parts: [{ type: "text", text: "my next message" }],
    origin: { kind: "person" },
  });
  expect(items.indexOf(handoff)).toBeLessThan(items.indexOf(person));
});
test("structured terminal errors survive event replay and snapshots", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frames.frame(start, {
            type: "turn.ended",
            agent: "root",
            outcome: "failed",
            error: { kind: "auth", message: "login expired" },
          }),
        ],
      },
    ],
    frames,
  );
  closes.push(h.close);
  const id = await h.create();
  const view = h.store.snapshotThread(id);
  expect(Object.values(view.runs)[0]).toMatchObject({
    state: "failed",
    error: { kind: "auth", code: "auth", title: "Not signed in to Codex", detail: "login expired" },
  });
  expect(h.store.readEvents({ afterSeq: 0, threadId: id, limit: 1000 })).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({
          type: "run.ended",
          error: expect.objectContaining({ code: "auth" }),
        }),
      }),
    ]),
  );
});
