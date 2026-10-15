import { afterEach, expect, test } from "vitest";
import { fixture, cleanupRecovery, text } from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";

afterEach(cleanupRecovery);

/** A provider whose first send reaches it but whose reply is lost, so delivery is uncertain. */
async function lostFirstReply() {
  const frames = scriptFrames();
  const h = await fixture([], frames);
  const delivered: unknown[] = [];
  const contexts: Parameters<typeof h.adapter.openSession>[0][] = [];
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        contexts.push(ctx);
        const session = await h.adapter.openSession(ctx);
        return {
          ...session,
          async send(input, delivery, commandId) {
            delivered.push(input);
            await session.send(input, delivery, commandId);
            if (delivered.length === 1) throw new Error("Lost delivery acknowledgement");
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const receipt = h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "codex",
    input: text("maybe ran"),
  });
  if (!receipt.threadId) throw new Error("Missing thread");
  await h.engine.flush();
  expect(h.engine.queue(receipt.threadId)).toMatchObject({
    paused: true,
    reason: "uncertain",
    messages: [{ input: text("maybe ran"), state: "uncertain" }],
  });
  return { h, frames, id: receipt.threadId, delivered, contexts };
}

test("an uncertain message settles once the provider ends a turn in its session, without being sent again", async () => {
  const { h, frames, id, delivered, contexts } = await lostFirstReply();
  contexts[0]?.onFrame(frames.frame(start, end));
  await h.engine.flush();
  expect(h.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
  expect(h.store.getThread(id)?.status.state).toBe("done");
  expect(delivered).toEqual([text("maybe ran")]);
  // The transcript still says the message may have run.
  expect(
    Object.values(h.store.snapshotThread(id).items).some(
      (item) => item.type === "notice" && item.code === "delivery_uncertain",
    ),
  ).toBe(true);
});

test("a new message goes ahead of an uncertain one, which is never sent again", async () => {
  const { h, id, delivered } = await lostFirstReply();
  expect(h.command({ type: "thread.send", threadId: id, input: text("next") }).ok).toBe(true);
  await h.engine.flush();
  expect(delivered).toEqual([text("maybe ran"), text("next")]);
  expect(h.engine.queue(id).messages).toEqual([]);
});
