import { expect, test } from "vitest";
import { spec, review, completion } from "@ace/conductor/test-support";
import { FakeConductor } from "./fake-conductor.ts";
import { runView } from "./run-view.ts";

function fixture() {
  let now = 1000;
  const conductor = new FakeConductor({ clock: () => now, runs: [] });
  expect(conductor.command({ type: "conductor.start", runId: "deck", spec: spec() })).toEqual({
    ok: true,
  });
  const run = () => {
    const entry = conductor.runs()[0];
    if (!entry) throw new Error("Run missing");
    return entry;
  };
  const view = () => runView(run());
  const lane = (role: string) => {
    const entry = view().lanes.find((candidate) => candidate.role === role);
    if (!entry) throw new Error(`Missing ${role}`);
    return entry;
  };
  const at = (time: number) => {
    now = time;
    conductor.observe("deck", { type: "tick" });
  };
  return { conductor, view, lane, at, run };
}

test("a done reviewer retries twice then escalates, and approving relaunches a reviewer", () => {
  const h = fixture();
  h.conductor.artifact(
    "deck",
    h.lane("worker").id,
    "worker-result",
    JSON.stringify({ kind: "completion", completion: completion("map") }),
  );
  const reviewer = h.lane("reviewer");
  for (let i = 0; i < 3; i++) {
    h.conductor.artifact("deck", reviewer.id, `review-${i}`, "bad JSON");
    if (i < 2) expect(h.lane("reviewer").status).toBe("working");
  }
  h.at(3000);
  const gate = h.view().needsUser.find((entry) => entry.kind === "escalation");
  if (!gate) throw new Error("Missing escalation");
  expect(h.run().execution?.corrections.map((entry) => entry.error)).toHaveLength(2);
  expect(
    h.conductor.command({
      type: "conductor.approve",
      runId: "deck",
      approval: { gateId: gate.id, decision: "approve" },
    }),
  ).toEqual({ ok: true });
  expect(h.lane("reviewer").id).not.toBe(reviewer.id);
});

test("a stalled fake worker's fenced completion closes its escalation", () => {
  const h = fixture();
  const worker = h.lane("worker");
  h.at(3000);
  expect(h.view().needsUser[0]?.kind).toBe("escalation");
  h.conductor.artifact(
    "deck",
    worker.id,
    "result",
    `Done.\n\`\`\`json\n${JSON.stringify({ kind: "completion", completion: completion("map") })}\n\`\`\`\nMore prose.`,
  );
  expect(h.view().needsUser).toEqual([]);
  expect(h.view().dag[0]?.state).toBe("reviewing");
});

test("a paused fake lane receives a fresh stall interval, and cancel waits for stop timeout", () => {
  const h = fixture();
  expect(h.conductor.command({ type: "conductor.pause", runId: "deck" })).toEqual({ ok: true });
  h.at(20000);
  expect(h.conductor.command({ type: "conductor.resume", runId: "deck" })).toEqual({ ok: true });
  h.at(20000);
  expect(h.view().needsUser).toEqual([]);
  const execution = h.run().execution;
  if (!execution) throw new Error("Missing execution");
  execution.holdStops = true;
  expect(h.conductor.command({ type: "conductor.cancel", runId: "deck" })).toEqual({ ok: true });
  expect(h.view().phase).toBe("cancelling");
  h.at(50000);
  expect(h.view().phase).toBe("cancelled");
  expect(h.view().lanes).toEqual([]);
});

test("a changes_required review without mutations starts a fix instead of escalating", () => {
  const h = fixture();
  h.conductor.artifact(
    "deck",
    h.lane("worker").id,
    "worker-result",
    JSON.stringify({ kind: "completion", completion: completion("map") }),
  );
  h.conductor.artifact(
    "deck",
    h.lane("reviewer").id,
    "review-result",
    JSON.stringify({
      kind: "review",
      revision: completion().revision,
      review: {
        ...review("map", "changes_required"),
        requirements: [
          { criterion: "Map the current behaviour", passed: false, evidence: "Build fails" },
        ],
        mutations: [],
        flakiness: { runs: 0, passed: false, evidence: "Build blocked repeats" },
      },
    }),
  );
  expect(h.view().dag[0]?.reviews?.[0]?.verdict).toBe("changes_required");
  expect(h.view().dag[0]?.fixRounds).toBe(1);
  expect(h.view().needsUser).toEqual([]);
});
