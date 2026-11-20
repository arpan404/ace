import { expect, test } from "vitest";
import { createAutoSave, type AutoSaveFile } from "./auto-save.ts";

/** A clock whose timers run only when the test moves it. */
function clock() {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  return {
    schedule(run: () => void, ms: number) {
      const timer = { at: now + ms, run };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
    async pass(ms: number) {
      now += ms;
      for (const timer of [...timers].filter((each) => each.at <= now)) {
        timers.delete(timer);
        timer.run();
      }
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

/** A file whose saves are recorded; `clash` makes the next save meet an agent's change. */
function file(path: string) {
  const state = { dirty: true, clash: false, saves: 0, nextClash: false };
  const port: AutoSaveFile = {
    snapshot: () => ({ dirty: state.dirty, clash: state.clash ? { by: "x" } : undefined }),
    save: async () => {
      if (state.nextClash) {
        state.nextClash = false;
        state.clash = true;
        return { kind: "clash" };
      }
      state.saves++;
      state.dirty = false;
      return { kind: "saved", version: "v2" };
    },
  };
  return { path, state, port };
}

function setup(mode: "off" | "pause" | "focus", delay = 1000) {
  const time = clock();
  const files = new Map([
    ["a.ts", file("a.ts")],
    ["b.ts", file("b.ts")],
  ]);
  const failures: string[] = [];
  const autoSave = createAutoSave({
    schedule: time.schedule,
    file: (path) => files.get(path)?.port,
    failed: (path, message) => failures.push(`${path}: ${message}`),
  });
  autoSave.configure({ mode, delay });
  const a = files.get("a.ts");
  const b = files.get("b.ts");
  if (!a || !b) throw new Error("no files");
  return { time, autoSave, a, b, failures };
}

test("after a pause in typing the edited file saves once", async () => {
  const { time, autoSave, a, b } = setup("pause");
  autoSave.edited("a.ts");
  await time.pass(600);
  autoSave.edited("a.ts");
  await time.pass(600);
  expect(a.state.saves).toBe(0);
  await time.pass(400);
  expect(a.state.saves).toBe(1);
  expect(b.state.saves).toBe(0);
  await time.pass(5000);
  expect(a.state.saves).toBe(1);
});

test("off never saves, whatever happens", async () => {
  const { time, autoSave, a } = setup("off");
  autoSave.edited("a.ts");
  autoSave.blurred("a.ts");
  await time.pass(10_000);
  expect(a.state.saves).toBe(0);
});

test("on focus change, a file saves when its editor loses focus, not while typing", async () => {
  const { time, autoSave, a } = setup("focus");
  autoSave.edited("a.ts");
  await time.pass(10_000);
  expect(a.state.saves).toBe(0);
  autoSave.blurred("a.ts");
  await time.pass(0);
  expect(a.state.saves).toBe(1);
});

test("an auto save that meets an agent's change stops auto-saving that file until saved by hand", async () => {
  const { time, autoSave, a } = setup("pause");
  a.state.nextClash = true;
  autoSave.edited("a.ts");
  await time.pass(1000);
  expect(a.state.clash).toBe(true);
  // The clash is answered (merged), the file is typed in again: still no auto save.
  a.state.clash = false;
  autoSave.edited("a.ts");
  await time.pass(1000);
  expect(a.state.saves).toBe(0);
  // Saved by hand: auto save picks up again.
  autoSave.savedByHand("a.ts");
  a.state.dirty = true;
  autoSave.edited("a.ts");
  await time.pass(1000);
  expect(a.state.saves).toBe(1);
});

test("turning auto save off cancels a save that was waiting", async () => {
  const { time, autoSave, a } = setup("pause");
  autoSave.edited("a.ts");
  autoSave.configure({ mode: "off", delay: 1000 });
  await time.pass(2000);
  expect(a.state.saves).toBe(0);
});
