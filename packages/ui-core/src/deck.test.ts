import { expect, test } from "vitest";
import { cardColumns, deckStepper, landingDeck, type DeckCard, type DeckRun } from "./deck.ts";

const card = (id: string, dependencies: string[] = []): DeckCard => ({
  id,
  kind: "work",
  title: id,
  dependencies,
  state: "planned",
  round: 0,
  lane: null,
  note: "",
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
  branch: "deck/streams",
  phase: "planning",
  planApproved: false,
  gate: null,
  stages: [],
  cards: [],
  log: [],
  pullRequest: null,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});
const labels = (r: DeckRun) => deckStepper(r).steps.map((s) => `${s.state}:${s.label}`);

test("the stepper moves from plan to dealing with merged progress, then to merged", () => {
  expect(labels(run({}))).toEqual(["done:Goal", "current:Plan", "todo:Dealing", "todo:Merge"]);
  const cards = [
    { ...card("a"), state: "merged" as const },
    card("b"),
    { ...card("merge"), kind: "merge" as const },
  ];
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
});

test("a paused or cancelled deck's stepper stops moving", () => {
  expect(deckStepper(run({ phase: "paused", planApproved: true })).paused).toBe(true);
  expect(deckStepper(run({ phase: "dealing", planApproved: true })).paused).toBe(false);
});

test("Deck lands on a gated deck first, then an active one, then the latest", () => {
  const gate = { id: "g", kind: "plan" as const, title: "", body: "", revision: 1, changes: [] };
  const finished = run({ id: "finished", phase: "merged" });
  const active = run({ id: "active", phase: "dealing" });
  const gated = run({ id: "gated", gate });
  expect(landingDeck([finished, active, gated])?.id).toBe("gated");
  expect(landingDeck([finished, active])?.id).toBe("active");
  expect(landingDeck([finished])?.id).toBe("finished");
  expect(landingDeck([])).toBeUndefined();
});
