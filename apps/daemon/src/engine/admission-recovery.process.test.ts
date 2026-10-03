import { afterEach, expect, test } from "vitest";
import {
  fixture,
  cleanupRecovery,
  replaceProvider,
  resume,
  text,
  restart,
  dispatch,
  crashCopy,
} from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";

afterEach(cleanupRecovery);

for (const delivery of ["queue", "steer"] as const) {
  test(`admitted recovery survives a rejected response and holds ${delivery} input until its delayed run`, async () => {
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
      { steer: true },
    );
    const id = await h.create();
    const replacement = replaceProvider(h, frames, [
      { on: "send" },
      { on: "send", frames: [frames.frame(start, end)] },
    ]);
    const adapter = h.registry.get("codex").adapter;
    h.registry.register(
      {
        ...adapter,
        async openSession(ctx) {
          const session = await adapter.openSession(ctx);
          return {
            ...session,
            async send(input, mode, commandId) {
              if (!commandId) throw new Error("Missing continuation correlation");
              ctx.onFrame(
                frames.frame({
                  type: "input.admitted",
                  agent: "root",
                  nativeInputId: commandId,
                  commandId,
                }),
              );
              await session.send(input, mode, commandId);
              if (commandId !== "recovery-command") return;
              throw new Error("Admitted continuation response lost");
            },
          };
        },
      },
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
    expect(resume(h, h.engine, id).ok).toBe(true);
    await h.engine.flush();
    expect(h.engine.queue(id).paused).toBe(false);
    expect(
      dispatch(
        h.store,
        h.engine,
        {
          type: "thread.resume",
          threadId: id,
          expectedRevision: h.engine.queue(id).revision,
        },
        "resume-again",
      ).error,
    ).toBe("recovery_in_progress");
    expect(
      h.command({ type: "thread.send", threadId: id, input: text("following"), delivery }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(replacement.commands.filter((command) => command.type === "send")).toHaveLength(1);
    expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "queue" });
    h.contexts.at(-1)?.onFrame(frames.frame(start, end));
    await h.engine.flush();
    expect(
      Object.values(h.store.snapshotThread(id).runs).some((run) => run.trigger === "limit_resume"),
    ).toBe(true);
    expect(
      replacement.commands
        .filter((command) => command.type === "send")
        .map((command) => command.input),
    ).toEqual([expect.any(Array), text("following")]);
    expect(h.store.getThread(id)?.status.state).toBe("done");
    expect(h.engine.queue(id).messages).toHaveLength(0);
    const engine = await restart(h);
    expect(
      dispatch(
        h.store,
        engine,
        {
          type: "thread.resume",
          threadId: id,
          expectedRevision: engine.queue(id).revision,
        },
        "resume-after-restart",
      ).ok,
    ).toBe(true);
    await engine.flush();
    expect(h.store.getThread(id)?.status.state).toBe("done");
    expect(replacement.commands.filter((command) => command.type === "send")).toHaveLength(2);
  });
}

for (const interruption of ["exit", "crash"] as const) {
  test(`admitted recovery interrupted by ${interruption} resumes native history with a fresh restart notice`, async () => {
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
    const admitted = replaceProvider(h, frames, [{ on: "send" }]);
    const adapter = h.registry.get("codex").adapter;
    h.registry.register(
      {
        ...adapter,
        async openSession(ctx) {
          const session = await adapter.openSession(ctx);
          return {
            ...session,
            async send(input, delivery, commandId) {
              if (!commandId) throw new Error("Missing correlation");
              await session.send(input, delivery, commandId);
              ctx.onFrame(
                frames.frame({
                  type: "input.admitted",
                  agent: "root",
                  nativeInputId: "resume",
                  commandId,
                }),
              );
              throw new Error("Lost reply");
            },
          };
        },
      },
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
    expect(resume(h, h.engine, id).ok).toBe(true);
    await h.engine.flush();
    const oldInput = admitted.commands.find((command) => command.type === "send");
    expect(oldInput).toBeDefined();
    let store = h.store,
      engine = h.engine;
    if (interruption === "exit") {
      h.contexts.at(-1)?.onExit({ deliberate: false, message: "Transport died" });
      await engine.flush();
    } else {
      ({ store, engine } = await crashCopy(h));
    }
    expect(engine.queue(id)).toMatchObject({ paused: true, reason: "restart" });
    const replacement = replaceProvider(h, frames, [
      {
        on: "send",
        frames: [
          frames.frame(
            {
              type: "input.admitted",
              agent: "root",
              nativeInputId: "fresh-restart",
              commandId: "restart-admitted-work",
            },
            start,
            end,
          ),
        ],
      },
    ]);
    expect(
      dispatch(
        store,
        engine,
        {
          type: "thread.resume",
          threadId: id,
          expectedRevision: engine.queue(id).revision,
        },
        "restart-admitted-work",
      ).ok,
    ).toBe(true);
    await engine.flush();
    const sent = replacement.commands.filter((command) => command.type === "send");
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toEqual(oldInput);
    expect(sent[0]).toMatchObject({
      input: [{ type: "text", text: expect.stringContaining("ace restarted") }],
    });
    expect(
      Object.values(store.snapshotThread(id).runs).some((run) => run.trigger === "restart"),
    ).toBe(true);
    expect(store.getThread(id)?.status.state).toBe("done");
    expect(engine.queue(id).messages).toHaveLength(0);
  });
}

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
