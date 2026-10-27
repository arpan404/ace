import { ThreadId, WorkspaceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { CheckoutMemory } from "./checkout-memory.ts";
import type { Timers } from "./kept-read.ts";
import type { KeptValue } from "./kept-value.ts";

/*
 * The phone's recent and open files: kept per thread on the device, in order, closable, and
 * read back at the next launch; each change answers with the thread's `files.memory` patch.
 */

const scope = { threadId: ThreadId.parse("t1") };
type Patch = Record<string, unknown>;

function device(): KeptValue & { kept: unknown } {
  const store = {
    kept: undefined as unknown,
    load: async () => store.kept,
    save: async (value: unknown) => {
      store.kept = JSON.parse(JSON.stringify(value));
    },
  };
  return store;
}
function screen() {
  const patches: Patch[] = [];
  return {
    patches,
    put: (_key: string, read: () => Patch | undefined) => {
      const value = read();
      if (value) patches.push(value);
    },
    last: () => patches.at(-1),
  };
}
const noTimers = { set: () => () => {} };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("opened files stay open in order, recents run newest first, and both survive a relaunch", async () => {
  const kept = device();
  const memory = new CheckoutMemory(kept, screen(), noTimers);
  for (const path of ["a.ts", "b.ts", "a.ts"])
    await memory.handle({ type: "files.opened", scope, path });
  await settle();
  const view = screen();
  await new CheckoutMemory(kept, view, noTimers).handle({ type: "files.memory.watch", scope });
  expect(view.last()).toMatchObject({
    key: "thread:t1",
    open: ["a.ts", "b.ts"],
    recent: ["a.ts", "b.ts"],
  });
});

test("closing a file, or all but one, leaves recents alone", async () => {
  const view = screen();
  const memory = new CheckoutMemory(device(), view, noTimers);
  for (const path of ["a.ts", "src/b.ts", "src/c.ts"])
    await memory.handle({ type: "files.opened", scope, path });
  await memory.handle({ type: "files.closed", scope, path: "src/" });
  expect(view.last()).toMatchObject({ open: ["a.ts"], recent: ["src/c.ts", "src/b.ts", "a.ts"] });
  await memory.handle({ type: "files.opened", scope, path: "d.ts" });
  await memory.handle({ type: "files.closed.others", scope, keep: "d.ts" });
  expect(view.last()?.open).toEqual(["d.ts"]);
});

test("a renamed file keeps its place and a deleted one is forgotten", async () => {
  const view = screen();
  const memory = new CheckoutMemory(device(), view, noTimers);
  for (const path of ["src/a.ts", "b.ts"])
    await memory.handle({ type: "files.opened", scope, path });
  await memory.handle({ type: "files.moved", scope, from: "src", to: "lib" });
  expect(view.last()).toMatchObject({ open: ["lib/a.ts", "b.ts"] });
  await memory.handle({ type: "files.forgot", scope, path: "b.ts" });
  expect(view.last()).toMatchObject({ open: ["lib/a.ts"], recent: ["lib/a.ts"] });
});

test("each thread and project folder keeps its own lists", async () => {
  const view = screen();
  const memory = new CheckoutMemory(device(), view, noTimers);
  await memory.handle({ type: "files.opened", scope, path: "a.ts" });
  await memory.handle({
    type: "files.opened",
    scope: { workspaceId: WorkspaceId.parse("ace") },
    path: "z.ts",
  });
  expect(view.last()).toMatchObject({ key: "project:ace", open: ["z.ts"] });
  expect(await memory.recent(scope)).toEqual(["a.ts"]);
});

test("unreadable kept lists start empty instead of failing", async () => {
  const kept = device();
  kept.kept = { recent: "nonsense" };
  const view = screen();
  await new CheckoutMemory(kept, view, noTimers).handle({ type: "files.memory.watch", scope });
  expect(view.last()).toMatchObject({ open: [], recent: [] });
});

/** Timers the test fires by hand. */
function handTimers(): Timers & { fire(): void } {
  const due: (() => void)[] = [];
  return {
    set(_delay, callback) {
      due.push(callback);
      return () => due.splice(due.indexOf(callback) >>> 0, 1);
    },
    fire: () => due.splice(0).forEach((callback) => callback()),
  };
}

test("a failed read of the kept lists is tried again and never saved over", async () => {
  const kept = device();
  const before = { recent: [["thread:t9", ["kept.ts"]]], open: [["thread:t9", ["kept.ts"]]] };
  kept.kept = before;
  const load = kept.load;
  let failures = 1;
  kept.load = async () => {
    if (failures-- > 0) throw new Error("host unavailable");
    return load();
  };
  const timers = handTimers();
  const view = screen();
  const memory = new CheckoutMemory(kept, view, timers);
  await memory.handle({ type: "files.opened", scope, path: "new.ts" });
  await settle();
  // Opening works at once, and what was kept is untouched while it can't be read.
  expect(view.last()).toMatchObject({ open: ["new.ts"] });
  expect(kept.kept).toBe(before);
  timers.fire();
  for (let tick = 0; tick < 5; tick++) await settle();
  expect(kept.kept).toEqual({
    recent: [
      ["thread:t1", ["new.ts"]],
      ["thread:t9", ["kept.ts"]],
    ],
    open: [
      ["thread:t1", ["new.ts"]],
      ["thread:t9", ["kept.ts"]],
    ],
  });
});
