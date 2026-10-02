import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ConductorDriver, ConductorStore, executor, fakePorts, progress } from "./index.ts";
import type { Lane, State } from "./index.ts";
import { accounts, completion, environment, plan, review, spec } from "./test-support.ts";

it("six workstreams survive migration, two fix rounds, a conflict, user escalation and restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ace-conductor-sim-"));
  const path = join(directory, "run.sqlite");
  const env = environment();
  const fake = fakePorts(env.now);
  let store = new ConductorStore(path);
  let driver = new ConductorDriver(store, executor(fake.ports), env);
  const dependencies = { a: [], b: [], c: ["a"], d: ["a"], e: ["b"], f: ["c", "d", "e"] };
  const artifact = plan(dependencies);
  let receipt = 0;
  let migrated = false;
  let escalations = 0;
  let restarted = false;
  let observedNormalReview = false;
  let observedIntegrator = false;
  const rounds = new Map<string, number>();
  const revision = new Map<string, string>();
  const current = (): State => {
    const s = store.load("run");
    if (!s) throw new Error("No run");
    return s;
  };
  const fact = (input: unknown) => driver.fact("run", `input-${++receipt}`, input);
  const finish = (lane: Lane, value: unknown) => {
    fact({ type: "artifact", laneId: lane.id, generation: lane.generation, artifact: value });
    fact({
      type: "status",
      laneId: lane.id,
      generation: lane.generation,
      status: "done",
      at: env.now(),
    });
  };
  try {
    driver.command("start", { type: "conductor.start", runId: "run", spec: spec() });
    fact({ type: "accounts", accounts });
    await driver.drain("run");
    const planner = Object.values(current().lanes).find((l) => l.role === "planner");
    if (!planner) throw new Error("No planner");
    finish(planner, { kind: "plan", plan: artifact });
    fake.conflicts.set("work/c", {
      message: "Two branches changed a shared build file",
      trivial: true,
    });
    for (let step = 0; step < 200 && current().phase !== "done"; step++) {
      await driver.drain("run");
      const s = current();
      for (const g of Object.values(s.gates)) {
        expect(g.kind).toBe("escalation");
        escalations++;
        driver.command(`approval-${++receipt}`, {
          type: "conductor.approve",
          runId: "run",
          approval: { gateId: g.id, decision: "approve" },
        });
      }
      for (const lane of Object.values(current().lanes).filter((l) => l.live)) {
        if (lane.role === "planner") continue;
        const id = lane.workstream;
        if (!id) throw new Error("No workstream");
        if (lane.role === "worker" && id === "a" && !migrated) {
          const history = fake.sessions.get(lane.id)?.history;
          fact({ type: "usage_limit", laneId: lane.id, generation: lane.generation });
          await driver.drain("run");
          const moved = fake.sessions.get(lane.id);
          expect(moved?.lane.account).toBe("two");
          expect(moved?.history).toEqual(history);
          expect(moved?.lane.generation).toBe(1);
          migrated = true;
          // Crash with the replacement live, then restore its generation and history.
          store.close();
          store = new ConductorStore(path);
          driver = new ConductorDriver(store, executor(fake.ports), env);
          restarted = true;
          continue;
        }
        if (lane.role === "worker" || lane.role === "integrator") {
          if (!fake.sessions.has(lane.id)) continue;
          const rev = receipt.toString(16).padStart(40, "0");
          revision.set(id, rev);
          if (lane.role === "integrator") observedIntegrator = true;
          finish(lane, { kind: "completion", completion: completion(id, rev) });
        } else if (lane.role === "reviewer") {
          if (!fake.sessions.has(lane.id)) continue;
          observedNormalReview ||= lane.model.tier === "normal" && lane.model.provider === "claude";
          const round = (rounds.get(id) ?? 0) + 1;
          rounds.set(id, round);
          const fail = (id === "b" && round <= 2) || (id === "d" && round <= 3);
          finish(lane, {
            kind: "review",
            review: review(id, fail ? "changes_required" : "pass"),
            revision: revision.get(id),
          });
        }
      }
    }
    await driver.drain("run");
    const view = progress(current());
    expect(view.phase).toBe("done");
    expect(view.dag.map((n) => n.state)).toEqual(Array(6).fill("integrated"));
    expect(view.needsUser).toEqual([]);
    expect(view.lanes).toEqual([]);
    expect(migrated && restarted && observedNormalReview && observedIntegrator).toBe(true);
    expect(rounds.get("b")).toBe(3);
    expect(rounds.get("d")).toBe(4);
    expect(escalations).toBe(1);
    const order = fake.merged.map((m) => m.branch.slice(5));
    expect(order).toHaveLength(6);
    for (const [id, deps] of Object.entries(dependencies))
      for (const dep of deps) expect(order.indexOf(dep)).toBeLessThan(order.indexOf(id));
    for (const [id, session] of fake.sessions) {
      expect(fake.tree.get(id)?.parentId).toBe(current().spec.rootAgentId);
      if (session.lane.source) expect(session.history.length).toBeGreaterThan(1);
    }
    expect(fake.interactions.size).toBe(0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
