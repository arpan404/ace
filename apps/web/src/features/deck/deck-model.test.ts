import { expect, test } from "vitest";
import { cardColumns, type DeckCard } from "./deck-model.ts";

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
