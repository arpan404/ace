import { afterEach, expect, test } from "vitest";
import {
  fixture,
  cleanupRecovery,
  replaceProvider,
  resume,
  text,
} from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";

afterEach(cleanupRecovery);

test("admission before a rejected RPC response establishes consumption without needing a run", async () => {
  const frames = scriptFrames();
  const h = await fixture([], frames);
  const adapter = h.registry.get("codex").adapter;
  h.registry.register(
    {
      ...adapter,
      async openSession(ctx) {
        const session = await adapter.openSession(ctx);
        return {
          ...session,
          async send(_input, _delivery, commandId) {
            if (!commandId) throw new Error("Missing correlation");
            ctx.onFrame(
              frames.frame(
                { type: "input.admitted", agent: "root", nativeInputId: "accepted", commandId },
                { type: "retry", agent: "root", on: "rate_limit", until: 4000 },
              ),
            );
            throw new Error("Admission RPC response lost");
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const id = await h.create();
  expect(Object.values(h.store.snapshotThread(id).runs)).toHaveLength(0);
  expect(h.engine.queue(id).messages).toHaveLength(0);
  expect(h.store.getThread(id)?.status.state).toBe("limited");
  const replacement = replaceProvider(h, frames, [
    {
      on: "send",
      frames: [
        frames.frame(
          {
            type: "input.admitted",
            agent: "root",
            nativeInputId: "continuation",
            commandId: "recovery-command",
          },
          start,
          end,
        ),
      ],
    },
  ]);
  expect(resume(h, h.engine, id).ok).toBe(true);
  await h.engine.flush();
  expect(replacement.commands.filter((command) => command.type === "send")).toHaveLength(1);
  expect(replacement.commands).not.toContainEqual(
    expect.objectContaining({ type: "send", input: text("first") }),
  );
});

test("native continuation keeps its trigger when admission precedes a delayed run", async () => {
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
  const id = await h.create();
  const replacement = replaceProvider(h, frames, [{ on: "send" }]);
  const adapter = h.registry.get("codex").adapter;
  h.registry.register(
    {
      ...adapter,
      async openSession(ctx) {
        const session = await adapter.openSession(ctx);
        return {
          ...session,
          async send(input, delivery, commandId) {
            if (!commandId) throw new Error("Missing continuation correlation");
            ctx.onFrame(
              frames.frame(
                { type: "input.admitted", agent: "root", nativeInputId: "resume", commandId },
                { type: "queue.changed", source: "provider", count: 1 },
              ),
            );
            await session.send(input, delivery, commandId);
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  expect(resume(h, h.engine, id).ok).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "queue" });
  h.contexts
    .at(-1)
    ?.onFrame(frames.frame({ type: "queue.changed", source: "provider", count: 0 }, start, end));
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("done");
  expect(
    Object.values(h.store.snapshotThread(id).runs).some((run) => run.trigger === "limit_resume"),
  ).toBe(true);
  expect(replacement.commands.filter((command) => command.type === "send")).toHaveLength(1);
});
