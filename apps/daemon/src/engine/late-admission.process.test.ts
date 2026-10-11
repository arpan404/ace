import { afterEach, expect, test } from "vitest";
import { CommandId } from "@ace/protocol";
import {
  fixture,
  cleanupRecovery,
  text,
  sends,
  crashCopy,
  dispatch,
} from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";

afterEach(cleanupRecovery);

test.each(["uncertain", "manual"])(
  "late correlated admission settles consumption while preserving a %s hold",
  async (hold) => {
    const frames = scriptFrames();
    const h = await fixture([{ on: "send" }], frames, {
      prepareInput: async (command) => ({
        input: command.payload.type === "thread.send" ? command.payload.input : [],
        release() {},
      }),
    });
    const original = h.registry.get("codex").adapter;
    h.registry.register(
      {
        ...original,
        async openSession(ctx) {
          const session = await original.openSession(ctx);
          return {
            ...session,
            async send(input, mode, commandId) {
              await session.send(input, mode, commandId);
              throw new Error("Admission reply lost");
            },
          };
        },
      },
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
    const hash = "a".repeat(64);
    const receipt = h.command(
      {
        type: "thread.create",
        workspaceId: h.workspace,
        provider: "codex",
        input: text("do once"),
        context: { mentions: [], attachments: [{ sha256: hash }] },
      },
      "device",
      "late-input",
    );
    expect(receipt.ok).toBe(true);
    if (!receipt.threadId) throw new Error("Missing thread");
    const id = receipt.threadId;
    await h.engine.flush();
    expect(h.engine.queue(id).messages).toMatchObject([{ id: "late-input", state: "uncertain" }]);
    expect(h.engine.retainsAttachment(id, hash)).toBe(true);
    if (hold === "manual")
      expect(
        h.command({
          type: "queue.pause",
          threadId: id,
          expectedRevision: h.engine.queue(id).revision,
        }).ok,
      ).toBe(true);
    const context = h.contexts[0];
    if (!context) throw new Error("Missing session");
    context.onFrame(
      frames.frame(
        {
          type: "input.admitted",
          agent: "root",
          nativeInputId: "native-late",
          commandId: "late-input",
        },
        start,
        end,
      ),
    );
    await h.engine.flush();
    expect(h.engine.queue(id)).toMatchObject({
      messages: [],
      pendingCount: 0,
      paused: hold === "manual",
      reason: hold === "manual" ? "manual" : null,
    });
    expect(h.engine.retainsAttachment(id, hash)).toBe(false);
    expect(h.engine.commandExecution(CommandId.parse("late-input"))).toBe("done");
    expect(h.store.snapshotThread(id).items["input:late-input"]).toMatchObject({
      nativeId: "native-late",
    });
    expect(
      Object.values(h.store.snapshotThread(id).items).some(
        (item) => item.type === "notice" && item.code === "delivery_uncertain",
      ),
    ).toBe(false);
    const copy = await crashCopy(h);
    expect(copy.engine.queue(id).messages).toEqual([]);
    expect(
      dispatch(
        copy.store,
        copy.engine,
        { type: "queue.resume", threadId: id, expectedRevision: copy.engine.queue(id).revision },
        "resume-confirmed",
      ).ok,
    ).toBe(true);
    await copy.engine.flush();
    expect(sends(h.adapter)).toHaveLength(1);
  },
);

test("late proof for a retired input cannot consume its replacement", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send" }, { on: "send" }], frames);
  const original = h.registry.get("codex").adapter;
  h.registry.register(
    {
      ...original,
      async openSession(ctx) {
        const session = await original.openSession(ctx);
        return {
          ...session,
          async send(input, mode, commandId) {
            await session.send(input, mode, commandId);
            throw new Error("Reply lost");
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const receipt = h.command(
    { type: "thread.create", workspaceId: h.workspace, provider: "codex", input: text("once") },
    "device",
    "retired",
  );
  if (!receipt.threadId) throw new Error("Missing thread");
  const id = receipt.threadId;
  await h.engine.flush();
  expect(
    h.command(
      {
        type: "queue.resend",
        threadId: id,
        expectedRevision: h.engine.queue(id).revision,
        messageId: CommandId.parse("retired"),
      },
      "device",
      "replacement",
    ).ok,
  ).toBe(true);
  await h.engine.flush();
  h.contexts[0]?.onFrame(
    frames.frame({
      type: "input.admitted",
      agent: "root",
      nativeInputId: "old-native",
      commandId: "retired",
    }),
  );
  await h.engine.flush();
  expect(h.engine.queue(id)).toMatchObject({
    reason: "uncertain",
    messages: [{ id: "replacement", state: "uncertain" }],
  });
  expect(h.engine.commandExecution(CommandId.parse("replacement"))).toBe("failed");
  expect(h.store.snapshotThread(id).items["input:retired"]).toBeUndefined();
  expect(sends(h.adapter)).toHaveLength(2);
});
