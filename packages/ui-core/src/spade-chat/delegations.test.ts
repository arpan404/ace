import { expect, test } from "vitest";
import {
  parseSpadeTree,
  spadeTreeWorkerState,
  spadeTreeWorkers,
  spadeWaitingWorkers,
  spadeWorkersTitle,
} from "./index.ts";

const tree = parseSpadeTree(
  JSON.stringify({
    tree: {
      kind: "bot",
      id: "research",
      state: "waiting",
      children: [
        { kind: "ace", id: "t1", name: "Pricing", state: "needs_you", needs_you: true },
        { kind: "ace", id: "t2", name: "Reviews", state: "ended" },
        { kind: "ace", id: "t3", name: "Features", state: "a-state-from-later" },
        { kind: "bot", id: "b1", name: "Writer", state: "idle" },
        { kind: "bot", id: "b2", name: "Linux repro", state: "working", needs_you: true },
      ],
    },
  }),
);

test("a worker reads as its tree says, and never done unless the tree says it settled", () => {
  const nodes = spadeTreeWorkers(tree);
  const state = (id: string) => spadeTreeWorkerState(nodes.get(id));
  expect(state("t1")).toBe("human");
  // Spade stopped following it: not running, and not done either.
  expect(state("t2")).toBe("cancelled");
  // A state this client doesn't know is still at work.
  expect(state("t3")).toBe("working");
  expect(state("b1")).toBe("done");
  // A bot whose own worker waits on the person needs them.
  expect(state("b2")).toBe("human");
  expect(state("missing")).toBeUndefined();
});

test("the card's heading says it started them until every one has ended", () => {
  expect(spadeWorkersTitle(["human", "working", "done", "done"])).toBe("Started 4 agents");
  expect(spadeWorkersTitle(["working"])).toBe("Started 1 agent");
  expect(spadeWorkersTitle(["done", "failed"])).toBe("2 agents ran");
});

test("the workers waiting on the person are listed once, in the order they started", () => {
  const cards = [
    {
      workers: [
        { id: "t1", kind: "ace" as const, name: "Pricing" },
        { id: "t2", kind: "ace" as const, name: "Reviews" },
      ],
    },
    {
      workers: [
        { id: "t1", kind: "ace" as const, name: "Pricing" },
        { id: "b2", kind: "bot" as const, name: "Linux repro" },
      ],
    },
  ];
  const states: Record<string, "human" | "working"> = {
    t1: "human",
    t2: "working",
    b2: "human",
  };
  expect(
    spadeWaitingWorkers(cards, (worker) => states[worker.id] ?? "working").map((w) => w.id),
  ).toEqual(["t1", "b2"]);
});
