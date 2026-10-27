import type { ReviewDraft } from "@ace/ui-core/review";
import { expect, test } from "vitest";
import { ChangesKept } from "./changes-kept.ts";
import { memoryValue } from "./changes-fixture.ts";
import type { Timers } from "./kept-read.ts";

/*
 * What the Changes sheet keeps on the phone: unsent and open review comments outlive any number
 * of viewed marks, and a read that fails never lets a save wipe what was kept.
 */

const settle = async () => {
  for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Timers the test fires by hand. */
function handTimers(): Timers & { fire(): void; due: number } {
  let due: (() => void)[] = [];
  return {
    set(_delay, callback) {
      due.push(callback);
      return () => {
        due = due.filter((each) => each !== callback);
      };
    },
    fire() {
      const now = due;
      due = [];
      for (const callback of now) callback();
    },
    get due() {
      return due.length;
    },
  };
}

const draft = (key: string, state: ReviewDraft["state"], createdAt: number): ReviewDraft => ({
  key,
  threadId: "t1",
  file: "src/replay.ts",
  side: "new",
  line: 5,
  text: `Comment ${key}`,
  state,
  fingerprint: { before: [], lines: ["line 5"], after: [] },
  createdAt,
});

const keptKeys = (held: unknown) =>
  ((held as { drafts?: { key: string }[] } | undefined)?.drafts ?? []).map((each) => each.key);

test("thousands of viewed marks never push out unsent or open review comments", async () => {
  const value = memoryValue();
  const kept = new ChangesKept(value, handTimers());
  await kept.load();
  kept.set(() => [draft("unsent", "draft", 1), draft("failed", "failed", 2), draft("open", "sent", 3)]);
  // 64 threads × 80 files with long paths: well over a megabyte of marks.
  const long = "src/".padEnd(200, "x");
  for (let thread = 0; thread < 64; thread++)
    for (let file = 0; file < 80; file++)
      kept.view(`thread-${thread}`, `${long}/${file}.ts`, `version-${thread}-${file}`);
  await settle();
  await kept.flushed();
  expect(keptKeys(value.held).toSorted()).toEqual(["failed", "open", "unsent"]);
  const marks = JSON.stringify((value.held as { viewed: unknown }).viewed);
  expect(new TextEncoder().encode(marks).length).toBeLessThanOrEqual(128 * 1024);
  // The newest marks are the ones kept.
  const relaunched = new ChangesKept(value, handTimers());
  await relaunched.load();
  expect(relaunched.viewed.get("thread-63")?.get(`${long}/79.ts`)).toBe("version-63-79");
  expect(relaunched.viewed.has("thread-0")).toBe(false);
  expect(relaunched.get().map((each) => each.key).toSorted()).toEqual([
    "failed",
    "open",
    "unsent",
  ]);
});

test("a save the host refuses is said in words and tried again", async () => {
  const value = memoryValue();
  const save = value.save;
  let refusals = 1;
  value.save = async (next) => {
    if (refusals-- > 0) throw new Error("storage.value.save failed");
    await save(next);
  };
  const timers = handTimers();
  const kept = new ChangesKept(value, timers);
  kept.set(() => [draft("unsent", "draft", 1)]);
  await settle();
  expect(kept.trouble).toContain("Couldn't save review comments");
  timers.fire();
  await settle();
  expect(keptKeys(value.held)).toEqual(["unsent"]);
  expect(kept.trouble).toBe("");
});

test("a failed read at launch is tried again, and nothing is saved over the kept comments meanwhile", async () => {
  const value = memoryValue();
  value.held = { v: 1, drafts: [draft("kept", "draft", 1)], viewed: [], layout: "split" };
  const before = value.held;
  const load = value.load;
  let failures = 2;
  value.load = async () => {
    if (failures-- > 0) throw new Error("storage.value.load failed");
    return load();
  };
  const timers = handTimers();
  const kept = new ChangesKept(value, timers);
  await kept.tried();
  expect(kept.trouble).toContain("Couldn't read the review");
  // A comment written while the read fails stays here and isn't saved over the kept value.
  kept.set((all) => [...all, draft("new", "draft", 2)]);
  await settle();
  expect(value.held).toBe(before);
  timers.fire();
  await settle();
  expect(value.held).toBe(before);
  expect(timers.due).toBe(1);
  timers.fire();
  await settle();
  await kept.flushed();
  expect(kept.trouble).toBe("");
  expect(kept.get().map((each) => each.key).toSorted()).toEqual(["kept", "new"]);
  expect(keptKeys(value.held).toSorted()).toEqual(["kept", "new"]);
  expect(kept.layout).toBe("split");
});
