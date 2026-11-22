import { afterEach, expect, test } from "vitest";
import { fixture, cleanupRecovery, text, sends, crashCopy } from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";

afterEach(cleanupRecovery);

for (const kind of ["thread.create", "thread.send"] as const) {
  test.each(["turn", "admission"])(
    `${kind} remains consumed when %s proof precedes a lost reply`,
    async (proof) => {
      const frames = scriptFrames();
      const h = await fixture(
        [{ on: "send", frames: [frames.frame(start, end)] }, { on: "send" }],
        frames,
      );
      const adapter = h.adapter;
      h.registry.register(
        {
          ...adapter,
          async openSession(ctx) {
            const session = await adapter.openSession(ctx);
            return {
              ...session,
              async send(input, delivery, commandId) {
                await session.send(input, delivery, commandId);
                if (commandId !== "lost-reply") return;
                ctx.onFrame(
                  frames.frame(
                    proof === "turn"
                      ? start
                      : {
                          type: "input.admitted",
                          agent: "root",
                          nativeInputId: "native-input",
                          commandId,
                        },
                  ),
                );
                throw new Error("Reply lost after consumption");
              },
            };
          },
        },
        { installed: true, auth: "logged_in", loginHint: "unused" },
      );
      const existing = kind === "thread.send" ? await h.create() : undefined;
      const receipt = h.command(
        existing
          ? { type: "thread.send", threadId: existing, input: text("do this once") }
          : {
              type: "thread.create",
              workspaceId: h.workspace,
              provider: "codex",
              input: text("do this once"),
            },
        "device",
        "lost-reply",
      );
      expect(receipt.ok).toBe(true);
      await h.engine.flush();
      const id = existing ?? receipt.threadId;
      if (!id) throw new Error("Missing thread");
      const assertConsumed = (store: typeof h.store) => {
        const items = Object.values(store.snapshotThread(id).items);
        expect(
          items.some(
            (item) =>
              item.type === "notice" &&
              item.commandId === "lost-reply" &&
              ["delivery_failed", "delivery_uncertain", "input_queued"].includes(item.code ?? ""),
          ),
        ).toBe(false);
        expect(store.snapshotThread(id).items["input:lost-reply"]).toMatchObject({
          type: "message",
          parts: text("do this once"),
        });
      };
      assertConsumed(h.store);
      expect(h.engine.queue(id).messages).toEqual([]);
      const before = sends(adapter).length;
      expect(before).toBe(kind === "thread.send" ? 2 : 1);
      const reopened = await crashCopy(h);
      await reopened.engine.flush();
      assertConsumed(reopened.store);
      expect(reopened.engine.queue(id).messages).toEqual([]);
      // The consumed input is never sent again. A turn still running when ace stopped continues
      // with one restart continuation instead.
      const after = sends(adapter).slice(before);
      expect(JSON.stringify(after)).not.toContain("do this once");
      expect(after).toHaveLength(proof === "turn" ? 1 : 0);
    },
  );
}

test("a message its provider started a turn for before the daemon stopped never reads as not sent", async () => {
  const hung = Promise.withResolvers<void>();
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  const adapter = h.adapter;
  h.registry.register(
    {
      ...adapter,
      async openSession(ctx) {
        const session = await adapter.openSession(ctx);
        return {
          ...session,
          async send(input, delivery, commandId) {
            if (commandId !== "taken") return session.send(input, delivery, commandId);
            // The provider takes it and starts its turn; the daemon stops before send returns.
            await ctx.onFrame(frames.frame(start));
            await hung.promise;
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const id = await h.create();
  h.command({ type: "thread.send", threadId: id, input: text("take this") }, "device", "taken");
  await expect.poll(() => h.store.getThread(id)?.status.state).toBe("working");
  const reopened = await crashCopy(h);
  hung.resolve();
  await reopened.engine.flush();
  const notices = Object.values(reopened.store.snapshotThread(id).items).flatMap((item) =>
    item.type === "notice" && item.commandId === "taken" ? [item.title ?? item.text ?? ""] : [],
  );
  expect(notices.join(" | ")).not.toMatch(/not sent/i);
  expect(reopened.store.snapshotThread(id).items["input:taken"]).toMatchObject({
    type: "message",
    parts: text("take this"),
  });
  expect(reopened.engine.queue(id).messages).toEqual([]);
  // The cut-off turn carried on with the restart's own continuation, and finished.
  expect(reopened.store.getThread(id)?.status.state).toBe("done");
});
