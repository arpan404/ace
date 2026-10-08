import { afterEach, expect, test } from "vitest";
import { closeDeckFixtures, deckFixture } from "./test-support.ts";
import { plan } from "./test-artifacts.ts";
import { spawnGitProcess } from "@ace/git";

afterEach(closeDeckFixtures);

test("a plan approved after an hour starts workers under the Deck deadline", async () => {
  const h = await deckFixture({ planApproval: "required" });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  const gated = await h.waitFor((run) => run.needsUser.some((gate) => gate.kind === "plan"));
  await h.advance(3_600_001);
  const gate = gated.needsUser[0];
  if (!gate) throw new Error("Plan gate missing");
  expect(
    await h.commands({
      type: "conductor.approve",
      runId: h.runId,
      approval: { gateId: gate.id, decision: "approve" },
    }),
  ).toMatchObject({ ok: true });
  await h.settle();
  const finished = await h.waitFor((run) => run.phase === "done" || !!run.executionError);
  expect(finished.executionError, h.executionErrors.join(",")).toBeUndefined();
  expect(finished.phase).toBe("done");
  expect(h.sends.some((send) => send.text.includes("Implement this workstream"))).toBe(true);
});

test("Deck lane starts do not consume the ordinary lifetime child allowance", async () => {
  const h = await deckFixture({
    delegationPolicy: { maxChildren: 2 },
    cards: plan({ a: [], b: ["a"] }),
  });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.settle();
  await h.waitFor((run) => run.dag[0]?.state === "integrated" || !!run.executionError);
  const finished = await h.waitFor((run) => run.phase === "done" || !!run.executionError);
  expect(finished.executionError, h.executionErrors.join(",")).toBeUndefined();
  expect(finished.phase).toBe("done");
  expect(h.sends.filter((send) => send.text.includes("adversarial reviewer"))).toHaveLength(2);
});

test("ordinary duration and usage limits cannot cancel an active Deck lane", async () => {
  const h = await deckFixture({ hold: true, delegationPolicy: { durationMs: 100 } });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) =>
    run.lanes.some((lane) => lane.role === "worker" && lane.status === "working"),
  );
  const worker = h.sends.find((send) => send.text.includes("Implement this workstream"));
  if (!worker) throw new Error("Worker missing");
  await h.usage(worker.thread, 1_000_001, 101);
  await h.advance(1000);
  expect(h.daemon.store.getThread(worker.thread)?.status.state).toBe("working");
  h.release();
  await h.finish(worker.thread);
  await h.waitFor((run) => run.phase === "done");
});

test("two accounts share the host lane concurrency instead of each admitting its own allowance", async () => {
  const h = await deckFixture({
    hold: true,
    crossProvider: true,
    parallel: 6,
    hostCapacity: 2,
    cards: plan({ a: [], b: [], c: [], d: [] }),
  });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) => run.lanes.filter((lane) => lane.status === "working").length === 2);
  await h.settle();
  const view = await h.read();
  expect(view.executionError).toBeUndefined();
  expect(view.lanes).toHaveLength(2);
  expect(view.dag.filter((card) => card.state === "pending")).toHaveLength(2);
  h.release();
  for (const worker of h.sends.filter((send) => send.text.includes("Implement this workstream")))
    await h.finish(worker.thread);
  for (const id of ["a", "b", "c", "d"])
    await h.waitFor((run) => run.dag.some((card) => card.id === id && card.state === "integrated"));
  await h.waitFor((run) => run.phase === "done");
});

test("pending CI on one card does not prevent another independent card from starting", async () => {
  const h = await deckFixture({ prOnly: true, parallel: 1, cards: plan({ a: [], b: [] }) });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) => run.dag[0]?.state === "verifying");
  await h.settle();
  expect(h.sends.filter((send) => send.text.includes("Implement this workstream"))).toHaveLength(2);
  h.forge.pass();
  await h.advance();
  await h.waitFor((run) => run.phase === "done");
});

test("a raced engine admission stays waiting and retries after its host slot is released", async () => {
  const h = await deckFixture({
    hold: true,
    engineCapacity: 2,
    stallAfterMs: 100,
    cards: plan({ a: [], b: [] }),
  });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) => !!run.executionError);
  await h.settle();
  const waiting = await h.read();
  expect(waiting.executionError).toBe("deck_capacity_wait");
  expect(waiting.lanes.some((lane) => lane.status === "waiting")).toBe(true);
  const worker = h.sends.find((send) => send.text.includes("Implement this workstream"));
  if (!worker) throw new Error("First worker missing");
  h.release();
  await h.finish(worker.thread);
  await h.settle();
  await h.advance(100);
  expect((await h.read()).needsUser).toEqual([]);
  await h.advance(900);
  await h.waitFor(
    (run) =>
      h.sends.filter((send) => send.text.includes("Implement this workstream")).length === 2 ||
      !!run.needsUser.length,
  );
  expect(h.sends.filter((send) => send.text.includes("Implement this workstream"))).toHaveLength(2);
  await h.waitFor((run) => run.dag[0]?.state === "integrated");
  await h.waitFor((run) => run.dag[1]?.state === "reviewing");
  await h.settle();
  await h.advance();
  await h.waitFor((run) => run.phase === "done");
});

test("cancelling a lane refused by the engine retires its prepared workspace registration", async () => {
  const h = await deckFixture({ hold: true, engineCapacity: 2, cards: plan({ a: [], b: [] }) });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) => run.executionError === "deck_capacity_wait");
  expect(await h.commands({ type: "conductor.cancel", runId: h.runId })).toMatchObject({
    ok: true,
  });
  await h.waitFor((run) => run.phase === "cancelled");
  await h.settle();
  const reply = await h.request(
    {
      type: "workspace.request",
      requestId: "retired",
      operation: { op: "workspaces.list", limit: 32 },
    },
    (message) => message.type === "workspace.result" && message.requestId === "retired",
  );
  if (reply.type !== "workspace.result" || reply.result?.kind !== "workspaces")
    throw new Error("Workspaces missing");
  expect(reply.result.workspaces.filter((workspace) => workspace.deck?.runId === h.runId)).toEqual(
    [],
  );
});

test("a failing lane preparation leaves independent lanes executable and backs off the failed intent", async () => {
  let preparations = 0;
  let failures = 0;
  const h = await deckFixture({
    hold: true,
    cards: plan({ a: [], b: [] }),
    git: {
      processRuntime: {
        spawn(binary, args, options) {
          if (args.includes("worktree") && args.includes("add")) {
            preparations++;
            if (preparations === 3) {
              failures++;
              return spawnGitProcess(process.execPath, ["-e", "process.exit(1)"], options);
            }
          }
          return spawnGitProcess(binary, args, options);
        },
      },
    },
  });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) =>
    run.lanes.some((lane) => lane.workstream === "b" && lane.status === "working"),
  );
  await h.settle();
  expect(failures).toBe(1);
  expect(h.sends.some((send) => send.text.includes("Build b"))).toBe(true);
  expect(h.sends.some((send) => send.text.includes("Build a"))).toBe(false);
  await h.settle();
  expect(preparations).toBe(4);
  await h.advance();
  await h.waitFor((run) =>
    run.lanes.some((lane) => lane.workstream === "a" && lane.status === "working"),
  );
  expect(h.sends.some((send) => send.text.includes("Build a"))).toBe(true);
});
