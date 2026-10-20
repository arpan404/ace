import { expect, test } from "vitest";
import { ThreadListView } from "@ace/protocol";
import { list, thread } from "./read-snapshots.fixture.ts";
import { FilterMemory } from "./sidebar-memory.ts";

/** A list of `count` rows. */
const rows = (count: number) =>
  ThreadListView.parse({
    kind: "threads",
    seq: 10,
    threads: Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`t${i}`, { ...thread, id: `t${i}` }]),
    ),
  });

test("the filter used least recently is forgotten first once the memory is full", () => {
  const memory = new FilterMemory(2);
  memory.remember("home", "a", list("A"));
  memory.remember("home", "b", list("B"));
  // Switching back to A makes B the oldest.
  expect(memory.provisional("home", "a")?.view.threads.thread?.title).toBe("A");
  memory.remember("home", "c", list("C"));
  expect(memory.provisional("home", "b")).toBeUndefined();
  expect(memory.provisional("home", "a")?.source).toBe("remembered");
  expect(memory.provisional("home", "c")?.source).toBe("remembered");
});

test("lists are forgotten oldest first once their rows pass the budget, and one over it is never kept", () => {
  const memory = new FilterMemory(8, 5);
  memory.remember("home", "a", rows(2));
  memory.remember("home", "b", rows(2));
  memory.remember("home", "c", rows(2));
  expect(memory.provisional("home", "a")).toBeUndefined();
  expect(memory.provisional("home", "b")?.source).toBe("remembered");
  memory.remember("home", "d", rows(6));
  expect(memory.provisional("home", "d")).toBeUndefined();
  expect(memory.provisional("home", "c")?.source).toBe("remembered");
});

test("a project's list is derived only from the all-projects list of the same half", () => {
  const memory = new FilterMemory();
  memory.remember("archive", undefined, list("Archived"));
  expect(memory.provisional("home", "project")).toBeUndefined();
  expect(memory.provisional("archive", "project")?.view.threads.thread?.title).toBe("Archived");
  expect(memory.provisional("archive", "elsewhere")).toBeUndefined();
});
