import { Item, Run } from "@ace/protocol";
import { expect, test } from "vitest";
import { thoughtLabel, thoughtMs } from "./thought-time.ts";

const thought = (id: string, createdAt: number, complete = true) =>
  Item.parse({
    id,
    threadId: "t",
    agentId: "root",
    runId: "r1",
    createdAt,
    type: "reasoning",
    complete,
    text: "Considering the options.",
  });
const answer = (id: string, createdAt: number) =>
  Item.parse({
    id,
    threadId: "t",
    agentId: "root",
    runId: "r1",
    createdAt,
    type: "message",
    role: "assistant",
    complete: true,
    parts: [{ type: "text", text: "Done." }],
  });

function reader(items: Item[], run?: Run) {
  const byId = new Map<string, Item>(items.map((item) => [item.id, item]));
  return {
    order: items.map((item) => item.id),
    item: (id: string) => byId.get(id),
    run: (id: string) => (run?.id === id ? run : undefined),
  };
}

test("a finished thought reads how long it took, up to what followed it", () => {
  const view = reader([thought("th", 1_000), answer("a", 13_000)]);
  expect(thoughtLabel(true, thoughtMs(view, "th"))).toBe("Thought for 12s");
});

test("a thought that ended its turn takes until the turn ended", () => {
  const run = Run.parse({
    id: "r1",
    threadId: "t",
    agentId: "root",
    trigger: "user",
    state: "completed",
    startedAt: 0,
    endedAt: 4_000,
  });
  expect(thoughtLabel(true, thoughtMs(reader([thought("th", 1_000)], run), "th"))).toBe(
    "Thought for 3s",
  );
});

test("a thought still going says Thinking, whatever follows it", () => {
  const view = reader([thought("th", 1_000, false), answer("a", 13_000)]);
  expect(thoughtLabel(false, thoughtMs(view, "th"))).toBe("Thinking…");
});

test("a quick thought, or one whose end is unknown, says no false time", () => {
  expect(
    thoughtLabel(true, thoughtMs(reader([thought("th", 1_000), answer("a", 1_400)]), "th")),
  ).toBe("Thought for a moment");
  expect(thoughtLabel(true, thoughtMs(reader([thought("th", 1_000)]), "th"))).toBe("Thought");
});
