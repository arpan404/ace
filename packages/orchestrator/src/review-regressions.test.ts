import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { apply, execute, recover, sideBySide, spawnAgent, type Executor } from "./index.ts";
import { stopFact, artifact, check, complete, fact, setup } from "./test-support.ts";

it("revived successful work remains owned by cancellation after restart", () => {
  const r = setup("fanout", 2);
  const [a, b] = r.lanes;
  if (!a || !b) throw new Error("Missing lanes");
  complete(r.state, a, r.ctx);
  check(r.state, a, r.ctx);
  r.send({ type: "cancel" });
  const revived = r.send({ type: "thread", ...fact(a), status: { state: "working", agents: 1 } });
  expect(revived.intents.map((i) => i.effect)).toEqual([{ type: "cancel", ...fact(a) }]);
  expect(r.state.stopReason).toBe("cancelled");
  const loaded = recover(JSON.parse(JSON.stringify(r.state)));
  apply(loaded.state, stopFact(loaded.state, b), r.ctx);
  expect(loaded.state.status).toBe("cancelling");
  expect(loaded.intents.some((i) => i.effect.type === "cancel" && i.effect.laneId === a.id)).toBe(
    true,
  );
  apply(loaded.state, stopFact(loaded.state, a), r.ctx);
  expect(loaded.state.status).toBe("cancelled");
});

it("a revived nested child preserves its cancelling planner and both cancellation effects execute", async () => {
  const r = setup("coordinator", 1);
  const parent = r.lanes[0];
  if (!parent) throw new Error("Missing planner");
  const spawned = spawnAgent(
    r.state,
    { laneId: parent.id, attempt: 1 },
    { requestId: "child", spec: parent.spec, prompt: "Subtask" },
    r.ctx,
  );
  const child = spawned.laneId ? r.state.lanes[spawned.laneId] : undefined;
  if (!child) throw new Error("Missing child");
  complete(r.state, child, r.ctx);
  check(r.state, child, r.ctx);
  complete(r.state, parent, r.ctx);
  const cancellations = r.send({ type: "cancel" });
  r.send({ type: "thread", ...fact(child), status: { state: "working", agents: 1 } });
  expect(parent.phase).toBe("cancelling");
  const stopped: string[] = [];
  const executor: Executor = {
    async start() {
      throw new Error("Unexpected start");
    },
    async check() {
      throw new Error("Unexpected check");
    },
    async merge() {
      throw new Error("Unexpected merge");
    },
    async cancel(request) {
      stopped.push(request.lane.id);
    },
  };
  const childCancel = Object.values(r.state.intents).find(
    (i) => i.effect.type === "cancel" && i.effect.laneId === child.id,
  );
  const parentCancel = cancellations.intents[0];
  if (!parentCancel || !childCancel) throw new Error("Missing cancel ownership");
  for (const entry of [parentCancel, childCancel])
    for (const f of await execute(r.state, entry, executor)) r.send(f);
  expect(stopped).toEqual([parent.id, child.id]);
  expect(r.state.status).toBe("cancelled");
});

it("reopening a successful descendant keeps its formerly successful ancestors active", () => {
  const r = setup("coordinator", 1);
  const parent = r.lanes[0];
  if (!parent) throw new Error("Missing planner");
  const spawned = spawnAgent(
    r.state,
    { laneId: parent.id, attempt: 1 },
    { requestId: "child", spec: parent.spec, prompt: "Subtask" },
    r.ctx,
  );
  const child = spawned.laneId ? r.state.lanes[spawned.laneId] : undefined;
  if (!child) throw new Error("Missing child");
  complete(r.state, child, r.ctx);
  check(r.state, child, r.ctx);
  complete(r.state, parent, r.ctx);
  check(r.state, parent, r.ctx);
  r.send({ type: "thread", ...fact(child), status: { state: "needs_you", interactions: 1 } });
  expect(r.state.status).toBe("waiting");
  expect(parent.phase).toBe("joining");
  expect(() => recover(JSON.parse(JSON.stringify(r.state)))).not.toThrow();
});

it("an obsolete ancestor check cannot approve work after a descendant reopens and completes again", () => {
  const r = setup("coordinator", 1);
  const parent = r.lanes[0];
  if (!parent) throw new Error("Missing planner");
  const spawned = spawnAgent(
    r.state,
    { laneId: parent.id, attempt: 1 },
    { requestId: "child", spec: parent.spec, prompt: "Subtask" },
    r.ctx,
  );
  const child = spawned.laneId ? r.state.lanes[spawned.laneId] : undefined;
  if (!child) throw new Error("Missing child");
  complete(r.state, child, r.ctx);
  check(r.state, child, r.ctx);
  const old = complete(r.state, parent, r.ctx).intents[0];
  if (!old) throw new Error("Missing old check");
  r.send({ type: "thread", ...fact(child), status: { state: "working", agents: 1 } });
  complete(r.state, child, r.ctx);
  const current = check(r.state, child, r.ctx).intents[0];
  if (!current) throw new Error("Missing fresh ancestor check");
  r.send({ type: "checked", ...fact(parent), intentId: old.id, commandPassed: true });
  expect(r.state.status).toBe("running");
  expect(parent.phase).toBe("checking");
  expect(
    Object.values(r.state.intents)
      .filter((i) => i.effect.type === "check")
      .map((i) => i.id),
  ).toEqual([current.id]);
  r.send({ type: "checked", ...fact(parent), intentId: current.id, commandPassed: true });
  expect(r.state.status).toBe("succeeded");
});

it("a deferred start receipt binds the current attempt after status arrives first and survives recovery", async () => {
  const r = setup("fanout", 1);
  const lane = r.lanes[0];
  const entry = r.initial.intents[0];
  if (!lane || !entry) throw new Error("Missing lane/start");
  const began = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<unknown>();
  const executor: Executor = {
    start() {
      began.resolve();
      return reply.promise;
    },
    async check() {
      throw new Error("Unexpected check");
    },
    async merge() {
      throw new Error("Unexpected merge");
    },
    async cancel() {
      throw new Error("Unexpected cancel");
    },
  };
  const pending = execute(r.state, entry, executor);
  await began.promise;
  r.send({ type: "thread", ...fact(lane), status: { state: "working", agents: 1 } });
  reply.resolve({ threadId: "deferred-thread", worktree: "/deferred-worktree" });
  for (const f of await pending) r.send(f);
  const loaded = recover(JSON.parse(JSON.stringify(r.state)));
  const recovered = loaded.state.lanes[lane.id];
  expect(recovered?.threadId).toBe(ThreadId.parse("deferred-thread"));
  expect(recovered?.worktree).toBe("/deferred-worktree");
  expect(recovered?.phase).toBe("working");
});

it("recovery refuses a cancelled run retaining a start intent", () => {
  const r = setup("fanout", 1);
  const start = r.initial.intents[0];
  const lane = r.lanes[0];
  if (!start || !lane) throw new Error("Missing lane/start");
  r.send({ type: "cancel" });
  r.send(stopFact(r.state, lane));
  expect(() => recover({ ...r.state, intents: { [start.id]: start } })).toThrow();
});

it("recovery refuses an intent addressed to an unknown lane", () => {
  const r = setup("fanout", 1);
  const start = r.initial.intents[0];
  if (!start) throw new Error("Missing start");
  const forged = { ...start, effect: { ...start.effect, laneId: "unknown-lane" } };
  expect(() => recover({ ...r.state, intents: { [start.id]: forged } })).toThrow(
    "Invalid intent ownership",
  );
});

it("side-by-side summaries signal truncated file metadata", () => {
  const result = sideBySide([
    {
      laneId: "lane",
      durationMs: 1,
      usage: { tokens: 1, cost: 0 },
      artifact,
      checksPassed: true,
      files: [],
      filesTruncated: true,
      patch: "",
      patchTruncated: false,
    },
  ]);
  expect(result.truncated).toBe(true);
});

it("recovery refuses receipt keys that cannot route their own replayed intent", () => {
  const r = setup("fanout", 1);
  const start = r.initial.intents[0];
  if (!start) throw new Error("Missing start");
  expect(() => recover({ ...r.state, intents: { "wrong-key": start } })).toThrow(
    "Invalid intent ownership",
  );
});

it("recovery refuses an intent for another attempt even when its phase is executable", () => {
  const r = setup("fanout", 1, { maxAttempts: 2 });
  const start = r.initial.intents[0];
  if (!start) throw new Error("Missing start");
  expect(() =>
    recover({
      ...r.state,
      intents: { [start.id]: { ...start, effect: { ...start.effect, attempt: 2 } } },
    }),
  ).toThrow("Invalid intent ownership");
});

it("old stop receipts cannot stop revived work with a new cancellation intent", () => {
  const r = setup("fanout", 1);
  const lane = r.lanes[0];
  if (!lane) throw new Error("Missing lane");
  const old = r.send({ type: "cancel" }).intents[0];
  if (!old) throw new Error("Missing cancellation");
  r.send({ type: "stopped", ...fact(lane), intentId: old.id });
  const fresh = r.send({ type: "thread", ...fact(lane), status: { state: "working", agents: 1 } })
    .intents[0];
  if (!fresh) throw new Error("Missing revived cancellation");
  r.send({ type: "stopped", ...fact(lane), intentId: old.id });
  expect(r.state.status).toBe("cancelling");
  expect(Object.values(r.state.intents).map((i) => i.id)).toEqual([fresh.id]);
  r.send({ type: "stopped", ...fact(lane), intentId: fresh.id });
  expect(r.state.status).toBe("cancelled");
});

it("a nested revival invalidates already accepted checks throughout the ancestor chain", () => {
  const r = setup("coordinator", 1);
  const root = r.lanes[0];
  if (!root) throw new Error("Missing root");
  const spawn = (parent: typeof root, requestId: string) => {
    const result = spawnAgent(
      r.state,
      { laneId: parent.id, attempt: parent.attempt },
      { requestId, spec: parent.spec, prompt: "Subtask" },
      r.ctx,
    );
    const child = result.laneId ? r.state.lanes[result.laneId] : undefined;
    if (!child) throw new Error("Missing child");
    return child;
  };
  const parent = spawn(root, "parent");
  const child = spawn(parent, "child");
  for (const lane of [child, parent, root]) {
    complete(r.state, lane, r.ctx);
    check(r.state, lane, r.ctx);
  }
  r.send({ type: "thread", ...fact(child), status: { state: "working", agents: 1 } });
  complete(r.state, child, r.ctx);
  expect(check(r.state, child, r.ctx).intents.map((i) => i.effect.laneId)).toEqual([parent.id]);
  expect(r.state.status).toBe("waiting");
  expect(check(r.state, parent, r.ctx).intents.map((i) => i.effect.laneId)).toEqual([root.id]);
  expect(r.state.status).toBe("running");
  check(r.state, root, r.ctx);
  expect(r.state.status).toBe("succeeded");
});

it("a later aggregate failure cannot leave a formerly successful lane successful", () => {
  const r = setup("fanout", 1);
  const lane = r.lanes[0];
  if (!lane) throw new Error("Missing lane");
  complete(r.state, lane, r.ctx);
  check(r.state, lane, r.ctx);
  r.send({ type: "thread", ...fact(lane), status: { state: "failed" } });
  expect(r.state.status).toBe("failed");
});
it("revival after a settled run's deadline creates cancellation rather than new unchecked work", () => {
  const r = setup("fanout", 1);
  const lane = r.lanes[0];
  if (!lane) throw new Error("Missing lane");
  complete(r.state, lane, r.ctx);
  check(r.state, lane, r.ctx);
  r.ctx.now += r.input.template.budget.durationMs;
  const result = r.send({ type: "thread", ...fact(lane), status: { state: "working", agents: 1 } });
  expect(result.intents.map((i) => i.effect)).toEqual([{ type: "cancel", ...fact(lane) }]);
  expect(r.state.stopReason).toBe("budget_exhausted");
});
