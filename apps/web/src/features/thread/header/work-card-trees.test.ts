import { expect, test } from "vitest";
import type { KeyValueStorage } from "@ace/ui-core";
import { createWorkCardStore } from "./work-card-store.ts";
import { createWorkCardTrees, workCardTreesKept } from "./work-card-trees.ts";

function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

/** A thread screen of `tree` with room to dock the card. */
function screen(trees: ReturnType<typeof createWorkCardTrees>, tree: string) {
  const store = createWorkCardStore();
  store.setSide(true);
  const stop = store.follow(trees.memory(tree));
  return { store, stop };
}

test("a subagent screen kept mounted opens its card when the main thread opens it", () => {
  const trees = createWorkCardTrees(memoryStorage());
  const main = screen(trees, "main");
  const subagent = screen(trees, "main");
  main.store.toggle();
  expect(subagent.store.get().open).toBe(true);
  subagent.store.setOpen(false);
  expect(main.store.get().open).toBe(false);
});

test("another tree's card stays as its person left it", () => {
  const trees = createWorkCardTrees(memoryStorage());
  const main = screen(trees, "main");
  const other = screen(trees, "other");
  main.store.toggle();
  expect(other.store.get().open).toBe(false);
});

test("a delegate's screen opening later finds the tree's card open", () => {
  const storage = memoryStorage();
  screen(createWorkCardTrees(storage), "main").store.toggle();
  // A reload: the choice comes back from storage.
  const delegate = screen(createWorkCardTrees(storage), "main");
  expect(delegate.store.get()).toEqual({ open: true, side: true });
});

test("a screen moving to another tree takes that tree's choice", () => {
  const trees = createWorkCardTrees(memoryStorage());
  screen(trees, "open-tree").store.toggle();
  const moving = screen(trees, "closed-tree");
  expect(moving.store.get().open).toBe(false);
  moving.stop();
  moving.store.follow(trees.memory("open-tree"));
  expect(moving.store.get().open).toBe(true);
  // It no longer follows the tree it left.
  screen(trees, "closed-tree").store.toggle();
  moving.store.setOpen(false);
  expect(trees.memory("closed-tree").open()).toBe(true);
});

test("a card opened elsewhere in the tree never pops over a narrow screen", () => {
  const trees = createWorkCardTrees(memoryStorage());
  const narrow = createWorkCardStore();
  narrow.setSide(false);
  narrow.follow(trees.memory("main"));
  screen(trees, "main").store.toggle();
  expect(narrow.get().open).toBe(false);
  // It docks once the screen has room.
  narrow.setSide(true);
  expect(narrow.get().open).toBe(true);
});

test("past the kept limit the oldest open tree reads as closed", () => {
  const storage = memoryStorage();
  const trees = createWorkCardTrees(storage);
  for (let index = 0; index <= workCardTreesKept; index++) trees.memory(`t${index}`).remember(true);
  const reloaded = createWorkCardTrees(storage);
  expect(reloaded.memory("t0").open()).toBe(false);
  expect(reloaded.memory(`t${workCardTreesKept}`).open()).toBe(true);
});

test("an unreadable stored value reads as every card closed", () => {
  const storage = memoryStorage();
  storage.setItem("ace.thread.workCardTrees", "{not json");
  expect(createWorkCardTrees(storage).memory("main").open()).toBe(false);
});
