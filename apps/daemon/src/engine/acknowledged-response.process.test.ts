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
      expect(sends(adapter)).toHaveLength(kind === "thread.send" ? 2 : 1);
      const reopened = await crashCopy(h);
      assertConsumed(reopened.store);
      expect(reopened.engine.queue(id).messages).toEqual([]);
      expect(sends(adapter)).toHaveLength(kind === "thread.send" ? 2 : 1);
    },
  );
}
