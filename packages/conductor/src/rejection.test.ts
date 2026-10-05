import { describe, expect, it } from "vitest";
import { progress, type Effect } from "./index.ts";
import { effectOf, Harness, mergeFact, plan, spec, verifyFact } from "./test-support.ts";

/*
 * What "reject" means for each gate (approval.ts). The fake daemon's conductor answers the same
 * way (packages/fake-daemon/src/conductor/fake-conductor.test.ts), so the Deck UI's copy is
 * pinned to the real conductor from both sides.
 */

const gateOf = (h: Harness, kind: string, workstream: string | null = null) => {
  const gate = progress(h.state).needsUser.find(
    (g) => g.kind === kind && (workstream === null || g.workstream === workstream),
  );
  if (!gate) throw new Error(`No ${kind} gate`);
  return gate;
};
const reject = (h: Harness, gateId: string) =>
  h.send({ type: "approve", approval: { gateId, decision: "reject" } });
const states = (h: Harness) => progress(h.state).dag.map((node) => node.state);
const cancels = (effects: Effect[]) =>
  effects.flatMap((e) => (e.type === "control" && e.action === "cancel" ? [e.lane.id] : []));

describe("rejecting a gate", () => {
  it("a plan is redrafted, and the planner is told which plan was rejected", () => {
    const h = new Harness(spec({ planApproval: "required" }));
    const effects = reject(h, gateOf(h, "plan").id);
    expect(progress(h.state).phase).toBe("planning");
    expect(progress(h.state).needsUser).toEqual([]);
    expect(progress(h.state).dag).toEqual([]);
    const launch = effectOf(effects, "launch");
    if (launch.type !== "launch") throw new Error("Expected launch");
    expect(launch.lane.role).toBe("planner");
    expect(launch.prompt).toContain("rejected an earlier plan");
    expect(launch.prompt).toContain("A bounded project");
    // The second draft asks again; approving it starts the work.
    h.finish(h.lane("planner"), { kind: "plan", plan: plan({ z: [] }) });
    h.send({ type: "approve", approval: { gateId: gateOf(h, "plan").id, decision: "approve" } });
    expect(progress(h.state).phase).toBe("running");
    expect(progress(h.state).lanes.map((l) => l.workstream)).toEqual(["z"]);
  });

  it("a merge declines only its card; the deck keeps running and finishes the rest", () => {
    const h = new Harness(spec({ merge: "ask" }), plan({ a: [], b: [] }));
    h.worker("a");
    h.worker("b", "b".repeat(40));
    h.reviewer("a");
    h.reviewer("b");
    reject(h, gateOf(h, "merge", "a").id);
    expect(progress(h.state).phase).toBe("running");
    expect(states(h)).toEqual(["declined", "approved"]);
    expect(progress(h.state).needsUser.map((g) => [g.kind, g.workstream])).toEqual([
      ["merge", "b"],
    ]);
    h.send({
      type: "approve",
      approval: { gateId: gateOf(h, "merge", "b").id, decision: "approve" },
    });
    const verify = effectOf(h.send(mergeFact(effectOf(h.effects, "merge"))), "verify");
    h.send(verifyFact(verify));
    expect(states(h)).toEqual(["declined", "integrated"]);
    expect(progress(h.state).phase).toBe("done");
  });

  it("a declined card's dependants never start, and the deck ends once nothing can move", () => {
    const h = new Harness(spec({ merge: "ask" }), plan({ a: [], b: ["a"] }));
    h.worker("a");
    h.reviewer("a");
    reject(h, gateOf(h, "merge", "a").id);
    expect(states(h)).toEqual(["declined", "pending"]);
    expect(progress(h.state).lanes).toEqual([]);
    expect(progress(h.state).phase).toBe("done");
  });

  it("an escalation stops that card's lane; other cards keep working", () => {
    const h = new Harness(spec(), plan({ a: [], b: [] }));
    const lane = h.lane("worker", "a");
    h.send({ type: "status", laneId: lane.id, generation: 0, status: "unresponsive", at: 100 });
    const effects = reject(h, gateOf(h, "escalation", "a").id);
    expect(cancels(effects)).toEqual([lane.id]);
    expect(states(h)).toEqual(["declined", "working"]);
    expect(progress(h.state).phase).toBe("running");
    // The cancelled lane settles; card b still runs to the end.
    h.send({ type: "status", laneId: lane.id, generation: 0, status: "done", at: 100 });
    h.worker("b", "b".repeat(40));
    h.reviewer("b");
    const verify = effectOf(h.send(mergeFact(effectOf(h.effects, "merge"))), "verify");
    h.send(verifyFact(verify));
    expect(progress(h.state).phase).toBe("done");
  });

  it("a destructive change declines the card and waits for its lane to stop", () => {
    const h = new Harness();
    const lane = h.lane("worker");
    h.send({ type: "destructive", laneId: lane.id, generation: 0, description: "Remove a tree" });
    expect(cancels(reject(h, gateOf(h, "destructive").id))).toEqual([lane.id]);
    expect(progress(h.state).phase).toBe("running");
    expect(states(h)).toEqual(["declined"]);
    h.send({ type: "status", laneId: lane.id, generation: 0, status: "done", at: h.env.now() });
    expect(progress(h.state).phase).toBe("done");
  });

  it("a budget stops the deck, while raising it lets the next lane start", () => {
    const tight = spec();
    const config = { ...tight, constraints: { ...tight.constraints, budget: 2 } };
    const raised = new Harness(config);
    raised.worker();
    const budget = gateOf(raised, "budget");
    expect(progress(raised.state).lanes).toEqual([]);
    raised.send({
      type: "approve",
      approval: { gateId: budget.id, decision: "approve", budget: 3 },
    });
    expect(progress(raised.state).lanes.map((l) => l.role)).toEqual(["reviewer"]);

    const stopped = new Harness(config);
    stopped.worker();
    reject(stopped, gateOf(stopped, "budget").id);
    expect(progress(stopped.state).needsUser).toEqual([]);
    expect(progress(stopped.state).phase).toBe("cancelled");
  });

  it("a deadline stops the deck and its live lanes", () => {
    const base = spec();
    const h = new Harness({ ...base, constraints: { ...base.constraints, deadline: 150 } });
    const lane = h.lane("worker");
    h.env.advance(100);
    h.send({ type: "tick" });
    const effects = reject(h, gateOf(h, "deadline").id);
    expect(cancels(effects)).toEqual([lane.id]);
    expect(progress(h.state).phase).toBe("cancelling");
  });

  it.each(["unresponsive", "failed"] as const)(
    "a declined card stays declined when its stopping lane later reports %s, a destructive change or done",
    (late) => {
      const h = new Harness(spec(), plan({ a: [], b: ["a"], c: [] }));
      const lane = h.lane("worker", "a");
      h.send({ type: "destructive", laneId: lane.id, generation: 0, description: "rm" });
      reject(h, gateOf(h, "destructive", "a").id);
      // The cancelled lane is still live while it stops; nothing it says moves the card.
      h.send({ type: "status", laneId: lane.id, generation: 0, status: late, at: h.env.now() });
      h.send({ type: "destructive", laneId: lane.id, generation: 0, description: "rm again" });
      expect(progress(h.state).needsUser.filter((g) => g.workstream === "a")).toEqual([]);
      h.send({ type: "status", laneId: lane.id, generation: 0, status: "done", at: h.env.now() });
      expect(states(h)).toEqual(["declined", "pending", "working"]);
      // The rest of the deck finishes; the declined card and its dependant never start.
      h.worker("c", "c".repeat(40));
      h.reviewer("c");
      h.send(verifyFact(effectOf(h.send(mergeFact(effectOf(h.effects, "merge"))), "verify")));
      expect(states(h)).toEqual(["declined", "pending", "integrated"]);
      expect(progress(h.state).phase).toBe("done");
      expect(progress(h.state).lanes).toEqual([]);
    },
  );
});
