import { expect, test } from "vitest";
import { spec } from "@ace/conductor/test-support";
import { FakeConductor } from "./fake-conductor.ts";
import { deckRuns } from "./decks.ts";

test("fake Decks wait on shared host capacity and continue independent cards within it", () => {
  let now = 1000;
  const template = deckRuns(now).find((run) => run.id === "relay-streams");
  const card = template?.cards.find((entry) => entry.kind === "work");
  if (!template || !card) throw new Error("Cards missing");
  const run = {
    ...template,
    gate: null,
    maxParallel: 6,
    hostCapacity: 0,
    spent: 1,
    budget: 100,
    cards: Array.from({ length: 6 }, (_, index) => ({
      ...card,
      id: `card-${index}`,
      dependencies: [],
      state: "planned" as const,
    })),
  };
  const conductor = new FakeConductor({ clock: () => now, runs: [run] });
  conductor.capacity(run.id, 0);
  expect(conductor.runs()[0]?.executionError).toBe("deck_capacity_wait");
  expect(conductor.runs()[0]?.cards.every((entry) => entry.state === "planned")).toBe(true);
  now += 100;
  conductor.capacity(run.id, 2);
  expect(conductor.runs()[0]?.executionError).toBe("deck_capacity_wait");
  expect(conductor.runs()[0]?.cards.every((entry) => entry.state === "planned")).toBe(true);
  now += 3_600_001;
  conductor.capacity(run.id, 2);
  expect(conductor.runs()[0]?.executionError).toBeUndefined();
  expect(conductor.runs()[0]?.cards.filter((entry) => entry.state === "working")).toHaveLength(2);
  expect(conductor.runs()[0]?.cards.filter((entry) => entry.state === "planned")).toHaveLength(4);
});

test("fake retryable effects retain their wait until the injected retry deadline", () => {
  let now = 1000;
  const conductor = new FakeConductor({ clock: () => now });
  conductor.fail("relay-streams", "deck_ci_pending");
  conductor.command({ type: "conductor.resume", runId: "relay-streams" });
  expect(conductor.runs().find((run) => run.id === "relay-streams")?.executionError).toBe(
    "deck_ci_pending",
  );
  now += 1000;
  conductor.command({ type: "conductor.resume", runId: "relay-streams" });
  expect(
    conductor.runs().find((run) => run.id === "relay-streams")?.executionError,
  ).toBeUndefined();
});

test("fake live Deck admission has no eight actor or retained history limit", () => {
  const conductor = new FakeConductor({ clock: () => 1000, runs: [] });
  for (let index = 0; index < 70; index++)
    expect(
      conductor.command({
        type: "conductor.start",
        runId: `gated-${index}`,
        spec: spec({ planApproval: "required" }),
      }),
    ).toEqual({ ok: true });
  expect(conductor.runs().filter((run) => run.gate?.kind === "plan")).toHaveLength(70);
});
