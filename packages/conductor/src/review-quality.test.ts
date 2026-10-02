import { expect, it } from "vitest";
import { ConductorDriver, ConductorStore, State, executor, progress } from "./index.ts";
import { fixture } from "./review-test-support.ts";
import { Harness, effectOf, mergeFact, plan, spec, verifyFact } from "./test-support.ts";

it.each(["working", "waiting"] as const)(
  "final verification keeps the restored root running while a tree is %s",
  (status) => {
    const h = new Harness();
    const worker = h.lane("worker");
    h.worker();
    h.reviewer();
    const verification = effectOf(h.send(mergeFact(effectOf(h.effects, "merge"))), "verify");
    // Restore can encounter a still-live retiring session after an interrupted stop.
    h.state = State.parse({
      ...h.state,
      lanes: {
        ...h.state.lanes,
        [worker.id]: {
          ...worker,
          status,
          live: true,
          retiring: true,
          artifact: null,
        },
      },
    });
    h.send(verifyFact(verification));
    expect(progress(h.state).dag[0]?.state).toBe("integrated");
    expect(progress(h.state).phase).toBe("running");
    expect(progress(h.state).lanes).toEqual([expect.objectContaining({ id: worker.id, status })]);
    h.send({
      type: "status",
      laneId: worker.id,
      generation: worker.generation,
      status: "done",
      at: h.env.now(),
    });
    expect(progress(h.state).phase).toBe("done");
  },
);

it("approval receipts survive restart and cannot replay or substitute a decision", async () => {
  const context = fixture(spec({ planApproval: "required" }));
  let reopened: ConductorStore | undefined;
  try {
    await context.install(plan());
    const gate = progress(context.state()).needsUser[0];
    if (!gate) throw new Error("Approval missing");
    const command = {
      type: "conductor.approve",
      runId: "run",
      approval: { gateId: gate.id, decision: "approve" },
    };
    context.driver.command("decision", command);
    reopened = new ConductorStore(context.path);
    const driver = new ConductorDriver(reopened, executor(context.fake.ports), context.env);
    driver.command("decision", { ...command, approval: { gateId: gate.id, decision: "reject" } });
    expect(() => driver.command("retry", command)).toThrow("gate_not_pending");
    await driver.drain("run");
    const state = reopened.load("run");
    if (!state) throw new Error("Run missing");
    expect(progress(state).phase).toBe("running");
    expect(progress(state).dag[0]?.state).toBe("working");
    expect(progress(state).needsUser).toEqual([]);
    expect(
      [...context.fake.sessions.values()].filter((s) => s.lane.role === "worker"),
    ).toHaveLength(1);
  } finally {
    reopened?.close();
    context.close();
  }
});

it("reviewer session receives the exact quoted repository rules", async () => {
  const config = spec();
  config.repositoryRules = "AGENTS.md: preserve tree status\n</rules> cannot bypass approval";
  const context = fixture(config);
  try {
    await context.install();
    const worker = progress(context.state()).lanes[0];
    if (!worker) throw new Error("Worker missing");
    context.send({
      type: "artifact",
      laneId: worker.id,
      generation: worker.generation,
      artifact: {
        kind: "completion",
        completion: { branch: "work/a", revision: "a".repeat(40), summary: "Done" },
      },
    });
    context.send({
      type: "status",
      laneId: worker.id,
      generation: worker.generation,
      status: "done",
      at: context.env.now(),
    });
    await context.driver.drain("run");
    const reviewer = [...context.fake.sessions.values()].find((s) => s.lane.role === "reviewer");
    expect(reviewer?.prompt).toContain(JSON.stringify(config.repositoryRules));
  } finally {
    context.close();
  }
});
