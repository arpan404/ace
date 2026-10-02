import { expect, it } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { commandHandler, execute, recover, type Executor, type ExecutionRequest } from "./index.ts";
import { artifact, complete, fact, setup } from "./test-support.ts";

const cmd = (payload: unknown) => Command.parse({ id: "command", deviceId: "device", payload });

function fakeExecutor() {
  const threads = new Map<
    string,
    { id: string; prompt: string; input?: string; stopped: boolean }
  >();
  const executor: Executor = {
    async start(request) {
      let thread = threads.get(request.intentId);
      if (!thread) {
        thread = {
          id: `thread-${request.intentId}`,
          prompt: request.lane.prompt,
          ...(request.artifact ? { input: request.artifact.checkpoint } : {}),
          stopped: false,
        };
        threads.set(request.intentId, thread);
      }
      return { threadId: thread.id, worktree: `/worktrees/${thread.id}` };
    },
    async check(request) {
      return { commandPassed: request.artifact.tests.failed === 0, reviewPassed: true };
    },
    async cancel(request) {
      for (const t of threads.values()) if (t.id === request.lane.threadId) t.stopped = true;
    },
    async merge() {
      return { safetyCheckpoint: "refs/ace/checkpoints/safety/1" };
    },
  };
  return { executor, threads };
}
it("replaying a lost start receipt binds the original fake thread and sends pipeline input", async () => {
  const r = setup("pipeline", 2);
  const [a, b] = r.lanes;
  if (!a || !b) throw new Error("Missing lanes");
  const start = r.initial.intents[0];
  if (!start) throw new Error("Missing intent");
  const fake = fakeExecutor();
  const first = await execute(r.state, start, fake.executor);
  const loaded = recover(JSON.parse(JSON.stringify(r.state)));
  const second = await execute(loaded.state, start, fake.executor);
  expect(second).toEqual(first);
  expect([...fake.threads.values()].map((t) => t.prompt)).toEqual([a.prompt]);
  for (const f of second) r.send(f);
  expect(a.threadId).toBe(ThreadId.parse(`thread-${start.id}`));
  const pendingCheck = complete(r.state, a, r.ctx).intents[0];
  if (!pendingCheck) throw new Error("Missing check");
  let next: ExecutionRequest | undefined;
  for (const f of await execute(r.state, pendingCheck, fake.executor)) {
    const result = r.send(f);
    const effect = result.intents[0];
    if (effect?.effect.type === "start") {
      for (const bound of await execute(r.state, effect, {
        ...fake.executor,
        async start(req) {
          next = req;
          return fake.executor.start(req);
        },
      }))
        r.send(bound);
    }
  }
  expect(next?.lane.id).toBe(b.id);
  expect([...fake.threads.values()].map((t) => t.input)).toEqual([undefined, artifact.checkpoint]);
});
it("invalid executor output and cancellation failure preserve durable intents for recovery", async () => {
  const r = setup("fanout", 1);
  const start = r.initial.intents[0];
  if (!start) throw new Error("Missing intent");
  const fake = fakeExecutor();
  await expect(
    execute(r.state, start, {
      ...fake.executor,
      async start() {
        return { threadId: 12 };
      },
    }),
  ).rejects.toThrow();
  expect(recover(JSON.parse(JSON.stringify(r.state))).intents).toContainEqual(start);
  const cancel = r.send({ type: "cancel" }).intents[0];
  if (!cancel) throw new Error("Missing cancel");
  await expect(
    execute(r.state, cancel, {
      ...fake.executor,
      async cancel() {
        throw new Error("engine offline");
      },
    }),
  ).rejects.toThrow("engine offline");
  expect(r.state.status).toBe("cancelling");
  expect(recover(JSON.parse(JSON.stringify(r.state))).intents).toContainEqual(cancel);
});
it("the command port creates, picks and cancels a run through the existing daemon wire command envelope", () => {
  const r = setup("fanout", 1);
  const a = r.lanes[0];
  if (!a) throw new Error("Missing lane");
  const runs = new Map([[r.state.id, r.state]]);
  const created: string[] = [];
  const handler = commandHandler({
    create(commandId, input) {
      created.push(`${commandId}:${input.prompt}`);
    },
    apply(_commandId, id, event) {
      const state = runs.get(id);
      if (!state) throw new Error("Unknown run");
      r.send(event);
    },
  });
  expect(handler.handle(cmd({ type: "orchestration.create", input: r.input })).ok).toBe(true);
  expect(created).toEqual([`command:${r.input.prompt}`]);
  complete(r.state, a, r.ctx);
  const check = Object.values(r.state.intents).find((i) => i.effect.type === "check");
  if (!check) throw new Error("Missing check");
  r.send({ type: "checked", ...fact(a), intentId: check.id, commandPassed: true });
  expect(
    handler.handle(
      cmd({
        type: "orchestration.pick",
        orchestrationId: r.state.id,
        runId: r.state.runId,
        laneId: a.id,
      }),
    ).ok,
  ).toBe(true);
  expect(r.state.winner).toBe(a.id);
  const active = setup("fanout", 1);
  const cancelHandler = commandHandler({
    create() {},
    apply(_c, _id, f) {
      active.send(f);
    },
  });
  expect(
    cancelHandler.handle(cmd({ type: "orchestration.cancel", orchestrationId: active.state.id }))
      .ok,
  ).toBe(true);
  expect(active.state.status).toBe("cancelling");
});

it("cancelled work never starts a new fake thread when old start intents are replayed", async () => {
  const r = setup("fanout", 1);
  const start = r.initial.intents[0];
  if (!start) throw new Error("Missing start");
  const fake = fakeExecutor();
  const cancel = r.send({ type: "cancel" }).intents[0];
  if (!cancel) throw new Error("Missing cancel");
  expect(await execute(r.state, start, fake.executor)).toEqual([]);
  expect([...fake.threads.values()]).toEqual([]);
  for (const f of await execute(r.state, cancel, fake.executor)) r.send(f);
  expect(r.state.status).toBe("cancelled");
});
