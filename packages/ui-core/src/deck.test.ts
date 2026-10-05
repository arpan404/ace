import { expect, test } from "vitest";
import {
  cardColumns,
  cardStatus,
  deckMerge,
  deckStepper,
  landingDeck,
  type DeckCard,
  type DeckRun,
  type Gate,
} from "./deck.ts";

const card = (id: string, dependencies: string[] = []): DeckCard => ({
  id,
  title: id,
  dependencies,
  state: "planned",
  round: 0,
  lane: null,
  note: "",
  agents: [],
  startedAt: undefined,
  updatedAt: undefined,
});
const titles = (columns: DeckCard[][]) => columns.map((column) => column.map((c) => c.id));

test("a card sits one column right of its deepest dependency", () => {
  const columns = cardColumns([
    card("seq"),
    card("cursor", ["seq"]),
    card("ack", ["seq"]),
    card("soak", ["cursor", "ack"]),
    card("docs", ["cursor"]),
    card("merge", ["soak", "docs", "seq"]),
  ]);
  expect(titles(columns)).toEqual([["seq"], ["cursor", "ack"], ["soak", "docs"], ["merge"]]);
});

test("a plan with a cycle or a missing dependency still lays out every card", () => {
  const columns = cardColumns([card("a", ["b"]), card("b", ["a"]), card("c", ["gone"])]);
  expect(
    columns
      .flat()
      .map((c) => c.id)
      .toSorted(),
  ).toEqual(["a", "b", "c"]);
  expect(columns[0]?.map((c) => c.id)).toContain("c");
});

const run = (patch: Partial<DeckRun>): DeckRun => ({
  id: "run",
  title: "Resumable streams",
  goal: "",
  workspaceId: "ace",
  phase: "planning",
  planApproved: false,
  gate: null,
  gates: [],
  startedAt: 0,
  updatedAt: 0,
  cards: [],
  agents: [],
  spent: 0,
  budget: 0,
  error: undefined,
  partial: false,
  plan: null,
  branch: null,
  baseBranch: null,
  planApproval: undefined,
  deadline: null,
  ...patch,
});
const labels = (r: DeckRun) => deckStepper(r).steps.map((s) => `${s.state}:${s.label}`);

test("the stepper moves from drafting the plan to dealing with merged progress, then to merged", () => {
  expect(labels(run({}))).toEqual([
    "done:Goal",
    "current:Drafting the plan",
    "todo:Dealing",
    "todo:Merge",
  ]);
  const plan = { summary: "Two cards", workstreams: [] };
  expect(labels(run({ plan }))[1]).toBe("current:Plan ready");
  const cards = [{ ...card("a"), state: "merged" as const }, card("b")];
  expect(labels(run({ phase: "dealing", planApproved: true, cards }))).toEqual([
    "done:Goal",
    "done:Plan approved",
    "current:Dealing · 1 of 2 merged",
    "todo:Merge",
  ]);
  expect(labels(run({ phase: "merged", planApproved: true, cards }))).toEqual([
    "done:Goal",
    "done:Plan approved",
    "done:Dealing · 1 of 2 merged",
    "done:Merged",
  ]);
  expect(labels(run({ phase: "cancelled", planApproved: true, cards })).slice(2)).toEqual([
    "done:Dealing · 1 of 2 merged",
    "current:Cancelled",
  ]);
});

const gate = (patch: Partial<Gate> = {}): Gate => ({
  id: "g",
  kind: "plan",
  ask: "plan",
  title: "",
  body: "",
  detail: undefined,
  workstream: null,
  gatedAt: 0,
  interaction: null,
  ...patch,
});

test("a paused, stopped or gated deck's stepper stops moving", () => {
  expect(deckStepper(run({ phase: "paused", planApproved: true })).paused).toBe(true);
  expect(deckStepper(run({ phase: "failed", planApproved: true })).paused).toBe(true);
  expect(deckStepper(run({ phase: "dealing", planApproved: true, gate: gate() })).paused).toBe(
    true,
  );
  expect(deckStepper(run({ phase: "dealing", planApproved: true })).paused).toBe(false);
});

test("Deck lands on the deck waiting longest on a decision, then the latest active one", () => {
  const finished = run({ id: "finished", phase: "merged", updatedAt: 900 });
  const older = run({ id: "older", phase: "dealing", updatedAt: 100 });
  const recent = run({ id: "recent", phase: "dealing", updatedAt: 500 });
  const waiting = run({ id: "waiting", gate: gate({ gatedAt: 50 }) });
  const fresh = run({ id: "fresh", gate: gate({ gatedAt: 400 }) });
  expect(landingDeck([finished, older, fresh, recent, waiting])?.id).toBe("waiting");
  expect(landingDeck([finished, older, recent])?.id).toBe("recent");
  expect(landingDeck([run({ id: "a", phase: "merged", updatedAt: 1 }), finished])?.id).toBe(
    "finished",
  );
  expect(landingDeck([])).toBeUndefined();
});

const lane = (status: "limited" | "unresponsive" | "working") => ({
  ...card("a"),
  state: "working" as const,
  round: 1,
  lane: { worker: null, reviewer: null, threadId: "t", status, rounds: [] },
});

test("a working card says when its lane ran out of quota, stopped answering, or its deck holds it", () => {
  const dealing = run({ phase: "dealing", planApproved: true });
  expect(cardStatus(lane("limited"), dealing)).toMatchObject({ label: "Waiting for quota" });
  expect(cardStatus(lane("unresponsive"), dealing)).toMatchObject({
    label: "Not responding",
    tone: "needs-you",
  });
  expect(cardStatus(lane("working"), dealing)).toMatchObject({ label: "Working", mark: "spinner" });
  expect(cardStatus(lane("working"), run({ phase: "paused" })).label).toBe("Paused");
  expect(cardStatus(lane("working"), run({ phase: "stopping" }))).toMatchObject({
    label: "Stopping",
    mark: "spinner",
  });
  // A cancelled deck's cards stop where they were; merged ones stay merged.
  expect(cardStatus(lane("working"), run({ phase: "cancelled" })).label).toBe("Cancelled");
  expect(cardStatus({ ...card("b"), state: "merged" }, run({ phase: "cancelled" })).label).toBe(
    "Merged",
  );
  const merge = gate({ kind: "merge", workstream: "a" });
  expect(cardStatus(lane("working"), run({ gate: merge, gates: [merge] })).label).toBe(
    "Ready to merge",
  );
});

test("the plan ends in one merge after every card nothing else waits on", () => {
  const cards = [card("a"), { ...card("b"), dependencies: ["a"] }, card("c")];
  expect(deckMerge(run({ phase: "dealing", cards }))).toEqual({
    detail: "Needs all 3",
    done: false,
    dependencies: ["b", "c"],
  });
  expect(deckMerge(run({ phase: "merged", cards })).detail).toBe("Merged");
});
