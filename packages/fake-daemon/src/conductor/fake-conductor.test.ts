import { expect, test } from "vitest";
import { FakeConductor } from "./fake-conductor.ts";

const relay = (conductor: FakeConductor) => {
  const run = conductor.runs().find((r) => r.id === "relay-streams");
  if (!run) throw new Error("missing relay deck");
  return run;
};

test("approving the plan revision moves the escalated card and deals the split card", () => {
  const conductor = new FakeConductor({ clock: () => 1_000_000 });
  const gate = relay(conductor).gate;
  expect(gate?.kind).toBe("plan");

  const result = conductor.command({
    type: "conductor.approve",
    runId: "relay-streams",
    approval: { gateId: gate?.id ?? "", decision: "approve" },
  });

  expect(result).toEqual({ ok: true });
  const run = relay(conductor);
  expect(run.gate).toBeNull();
  const states = Object.fromEntries(run.cards.map((c) => [c.title, c.state]));
  expect(states["Mobile cold-start replay"]).toBe("working");
  expect(states["Simulator replay test"]).toBe("planned");
  expect(run.cards.find((c) => c.kind === "merge")?.dependencies).toContain(
    "simulator-replay-test",
  );
});

test("a decision on a gate that is no longer open is refused", () => {
  const conductor = new FakeConductor({ clock: () => 1 });
  const result = conductor.command({
    type: "conductor.approve",
    runId: "relay-streams",
    approval: { gateId: "relay-streams-rev-1", decision: "approve" },
  });
  expect(result).toEqual({ ok: false, error: "stale_gate" });
  expect(relay(conductor).gate?.revision).toBe(2);
});

test("pause and resume return the deck to the phase it was in", () => {
  const conductor = new FakeConductor({ clock: () => 1 });
  conductor.command({ type: "conductor.pause", runId: "mobile-cold-start" });
  const paused = conductor.runs().find((r) => r.id === "mobile-cold-start");
  expect(paused?.phase).toBe("paused");
  conductor.command({ type: "conductor.resume", runId: "mobile-cold-start" });
  expect(conductor.runs().find((r) => r.id === "mobile-cold-start")?.phase).toBe("dealing");
});
