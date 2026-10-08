import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AgentId } from "@ace/protocol";
import { spawnGitProcess } from "@ace/git";
import { closeDeckFixtures, deckFixture, git } from "./test-support.ts";

afterEach(closeDeckFixtures);

test("restart completes a failed terminal cleanup without relaunching a lane", async () => {
  let failRemoval = true;
  const h = await deckFixture({
    git: {
      processRuntime: {
        spawn(binary, args, options) {
          if (failRemoval && args.includes("worktree") && args.includes("remove")) {
            failRemoval = false;
            return spawnGitProcess(process.execPath, ["-e", "process.exit(1)"], options);
          }
          return spawnGitProcess(binary, args, options);
        },
      },
    },
  });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) => run.phase === "done" && !!run.executionError);
  const sends = h.sends.length;
  await h.restart();
  await h.subscribe();
  await h.advance();
  await h.settle();
  expect(git(h.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  expect(h.sends).toHaveLength(sends);
  expect(
    git(h.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/deck/")
      .split("\n")
      .filter(Boolean),
  ).toHaveLength(1);
});

test("more than eight gated Decks start and restart reconciles every live run", async () => {
  const h = await deckFixture({ planApproval: "required" });
  const ids = Array.from({ length: 10 }, (_, index) => `gated-${index}`);
  for (const runId of ids) {
    expect(
      await h.commands({
        type: "conductor.start",
        runId,
        spec: { ...h.spec, rootAgentId: AgentId.parse(randomUUID()) },
      }),
    ).toMatchObject({ ok: true });
    await h.settle();
  }
  expect(
    (await h.listRuns()).filter((run) => h.daemon.conductor?.get(run.id)?.needsUser.length),
  ).toHaveLength(10);
  await h.restart();
  await h.settle();
  expect(h.daemon.conductor?.active().toSorted()).toEqual(ids.toSorted());
  // Each persisted gate remains answerable, including runs beyond the old restart limit.
  for (const runId of ids) {
    const gate = h.daemon.conductor?.get(runId)?.needsUser[0];
    if (!gate) throw new Error("Gate missing");
    expect(
      await h.commands({
        type: "conductor.approve",
        runId,
        approval: { gateId: gate.id, decision: "reject" },
      }),
    ).toMatchObject({ ok: true });
    await h.settle();
  }
  expect(h.sends.filter((send) => send.text.includes("Plan this project"))).toHaveLength(20);
});

test.each(["done", "cancelled"] as const)(
  "%s releases Deck trees, lane branches and workspace registrations while keeping the integration branch",
  async (phase) => {
    const h = await deckFixture({ hold: phase === "cancelled" });
    expect(await h.startRun()).toMatchObject({ ok: true });
    await h.subscribe();
    if (phase === "cancelled") {
      await h.waitFor((run) =>
        run.lanes.some((lane) => lane.role === "worker" && lane.status === "working"),
      );
      expect(await h.commands({ type: "conductor.cancel", runId: h.runId })).toMatchObject({
        ok: true,
      });
    }
    await h.waitFor((run) => run.phase === phase);
    await h.settle();
    expect(git(h.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(
      git(h.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/deck/")
        .split("\n")
        .filter(Boolean),
    ).toHaveLength(1);
    const requestId = randomUUID();
    const reply = await h.request(
      { type: "workspace.request", requestId, operation: { op: "workspaces.list", limit: 100 } },
      (message) => message.type === "workspace.result" && message.requestId === requestId,
    );
    if (reply.type !== "workspace.result" || reply.result.kind !== "workspaces")
      throw new Error("Workspace page missing");
    expect(reply.result.workspaces.map((workspace) => workspace.id)).toEqual([h.spec.workspaceId]);
    expect((await h.read()).delegations.length).toBeGreaterThan(0);
    await h.restart();
    await h.settle();
    expect(git(h.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  },
);

test("status activity continues at the input receipt limit and does not spend the control reserve", async () => {
  const h = await deckFixture({ hold: true });
  expect(await h.startRun()).toMatchObject({ ok: true });
  await h.subscribe();
  await h.waitFor((run) =>
    run.lanes.some((lane) => lane.role === "worker" && lane.status === "working"),
  );
  await h.settle();
  const worker = h.sends.find((send) => send.text.includes("Implement this workstream"));
  if (!worker) throw new Error("Worker missing");
  const db = new DatabaseSync(join(h.home, "daemon", "conductor.sqlite"));
  try {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT OR IGNORE INTO conductor_inputs(run,id) VALUES (?,?)");
    for (let i = 0; i < 65_536; i++) insert.run(h.runId, `seed-${i}`);
    db.exec("COMMIT");
    const before = db.prepare("SELECT inputs FROM conductor_runs WHERE id=?").get(h.runId)?.inputs;
    await h.beginStream(worker.thread);
    h.clock.advance(h.clock.now() + 10);
    await h.stream(worker.thread, "activity");
    await h.advance();
    expect((await h.read()).updatedAt).toBe(h.clock.now());
    expect(db.prepare("SELECT inputs FROM conductor_runs WHERE id=?").get(h.runId)?.inputs).toBe(
      before,
    );
    expect(await h.commands({ type: "conductor.pause", runId: h.runId })).toMatchObject({
      ok: true,
    });
    await h.settle();
    expect((await h.read()).phase).toBe("paused");
  } finally {
    db.close();
  }
});

test("Deck pages use activity then creation order with an opaque cursor across equal timestamps", async () => {
  const h = await deckFixture({ planApproval: "required" });
  const ids = ["z-old", "m-mid", "b-new", "a-new"];
  for (const runId of ids) {
    expect(
      await h.commands({
        type: "conductor.start",
        runId,
        spec: { ...h.spec, rootAgentId: AgentId.parse(randomUUID()) },
      }),
    ).toMatchObject({ ok: true });
    await h.settle();
    if (runId === "z-old" || runId === "m-mid") await h.advance(10);
  }
  const readPage = async (after?: string) => {
    const requestId = randomUUID();
    const reply = await h.request(
      {
        type: "conductor.request",
        requestId,
        operation: { op: "list", limit: 1, ...(after ? { after } : {}) },
      },
      (message) => message.type === "conductor.result" && message.requestId === requestId,
    );
    if (reply.type !== "conductor.result" || !reply.ok) throw new Error("List missing");
    return reply;
  };
  expect((await readPage()).runs?.[0]?.id).toBe("a-new");
  await h.advance(10);
  expect(await h.commands({ type: "conductor.pause", runId: "z-old" })).toMatchObject({ ok: true });
  await h.settle();
  const first = await readPage();
  const second = await readPage(first.next);
  const third = await readPage(second.next);
  const fourth = await readPage(third.next);
  expect(
    [first, second, third, fourth].flatMap((page) => page.runs?.map((run) => run.id) ?? []),
  ).toEqual(["z-old", "a-new", "b-new", "m-mid"]);
  expect(fourth.next).toBeUndefined();
});
