import { expect, test } from "vitest";
import { list } from "./read-snapshots.fixture.ts";
import { FilterMemory } from "./sidebar-memory.ts";

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

test("a project's list is derived only from the all-projects list of the same half", () => {
  const memory = new FilterMemory();
  memory.remember("archive", undefined, list("Archived"));
  expect(memory.provisional("home", "project")).toBeUndefined();
  expect(memory.provisional("archive", "project")?.view.threads.thread?.title).toBe("Archived");
  expect(memory.provisional("archive", "elsewhere")).toBeUndefined();
});
