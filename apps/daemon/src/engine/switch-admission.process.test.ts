import { afterEach, expect, test } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { fixture, cleanupRecovery, text, resume } from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";

afterEach(cleanupRecovery);

test("an admitted switched recovery does not repeat its portable handoff after a lost reply", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      {
        on: "send",
        frames: [
          frames.frame(start, {
            type: "turn.ended",
            agent: "root",
            outcome: "failed",
            error: { kind: "quota", message: "Quota" },
          }),
        ],
      },
    ],
    frames,
  );
  const destination = createScriptedAdapter({
    provider: "claude",
    capabilities: h.registry.get("codex").capabilities,
    nativeSessionId: "destination-session",
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
    steps: [{ on: "send" }, { on: "send", frames: [frames.frame(start, end)] }],
  });
  h.registry.register(
    {
      ...destination,
      async openSession(context) {
        h.contexts.push(context);
        const session = await destination.openSession(context);
        return {
          ...session,
          async send(input, delivery, commandId) {
            if (!commandId) throw new Error("Missing input correlation");
            context.onFrame(
              frames.frame({
                type: "input.admitted",
                agent: "root",
                nativeInputId: commandId,
                commandId,
              }),
            );
            await session.send(input, delivery, commandId);
            if (commandId === "recovery-command") throw new Error("Lost recovery receipt");
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "fake" },
  );
  const id = await h.create();
  expect(
    h.command({ type: "thread.switch", threadId: id, selection: { provider: "claude" } }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.command({ type: "thread.send", threadId: id, input: text("following") }).ok).toBe(true);
  expect(resume(h, h.engine, id).ok).toBe(true);
  await h.engine.flush();
  const admitted = destination.commands.find((command) => command.type === "send");
  expect(JSON.stringify(admitted)).toContain("sourceThreadId");
  h.contexts.at(-1)?.onFrame(frames.frame(start, end));
  await h.engine.flush();
  const sends = destination.commands.filter((command) => command.type === "send");
  expect(sends).toHaveLength(2);
  expect(sends[1]).toMatchObject({ input: text("following") });
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("switching from admission-based delivery to run acknowledgement consumes the preserved queue", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  const source = h.registry.get("codex").adapter;
  h.registry.register(
    {
      ...source,
      async openSession(context) {
        const session = await source.openSession(context);
        return {
          ...session,
          async send(input, delivery, commandId) {
            if (!commandId) throw new Error("Missing input correlation");
            context.onFrame(
              frames.frame({
                type: "input.admitted",
                agent: "root",
                nativeInputId: commandId,
                commandId,
              }),
            );
            await session.send(input, delivery, commandId);
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "fake" },
  );
  const destination = createScriptedAdapter({
    provider: "claude",
    capabilities: h.registry.get("codex").capabilities,
    nativeSessionId: "destination-session",
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
    steps: [{ on: "send", frames: [frames.frame(start, end)] }],
  });
  h.registry.register(destination, { installed: true, auth: "logged_in", loginHint: "fake" });
  const id = await h.create();
  expect(h.store.getThread(id)?.status.state).toBe("done");
  expect(
    h.command({ type: "queue.pause", threadId: id, expectedRevision: h.engine.queue(id).revision })
      .ok,
  ).toBe(true);
  expect(h.command({ type: "thread.send", threadId: id, input: text("preserved input") }).ok).toBe(
    true,
  );
  const queued = h.engine.queue(id).messages;
  expect(
    h.command({ type: "thread.switch", threadId: id, selection: { provider: "claude" } }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(id)?.provider).toBe("claude");
  expect(h.engine.queue(id).messages).toEqual(queued);
  expect(
    h.command({ type: "queue.resume", threadId: id, expectedRevision: h.engine.queue(id).revision })
      .ok,
  ).toBe(true);
  await h.engine.flush();
  expect(destination.commands.filter((command) => command.type === "send")).toHaveLength(1);
  expect(h.engine.queue(id).messages).toHaveLength(0);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});
