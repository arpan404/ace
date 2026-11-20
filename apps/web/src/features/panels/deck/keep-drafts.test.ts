import { afterEach, expect, test } from "vitest";
import { createBufferRegistry, type BufferRegistry } from "@/features/editor-workbench/index.ts";
import {
  fakeDisk,
  inlineMerge,
  manualTime,
  memoryDrafts,
  ready,
  settle,
} from "@/features/editor-workbench/buffers/test-support.ts";
import { keepDrafts } from "./keep-drafts.ts";
import type { UnsavedAnswer } from "./unsaved-prompt.tsx";

/*
 * Hot exit (spec 50): unsaved text reaches the device when the page hides or the desktop app
 * quits, and only text that isn't kept makes leaving the page, or quitting the app, ask.
 */

const file = { root: "m1/t1", path: "store.ts" };
let undo: (() => void) | undefined;
afterEach(() => {
  undo?.();
  undo = undefined;
  Reflect.deleteProperty(window, "ace");
});

async function typed(
  drafts: ReturnType<typeof memoryDrafts>,
  disk = fakeDisk({ "store.ts": "one\n" }),
) {
  await ready();
  const registry = createBufferRegistry({
    files: disk.port,
    drafts: drafts.store,
    merge: inlineMerge().port,
    now: manualTime().now,
    // Typing never pauses long enough on its own: only a flush writes the draft.
    schedule: () => () => {},
    ready,
  });
  const lease = registry.open(file);
  lease.setVisible(true);
  await settle();
  const doc = lease.buffer.document();
  doc?.apply([
    { range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }, text: "mine " },
  ]);
  lease.buffer.edited();
  return registry;
}

const leave = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

test("hiding the page writes pending drafts, and leaving asks only when one can't be kept", async () => {
  const drafts = memoryDrafts();
  const registry: BufferRegistry = await typed(drafts);
  undo = keepDrafts(() => [registry]);
  window.dispatchEvent(new Event("pagehide"));
  await settle();
  expect((await drafts.store.get(file))?.text).toBe("mine one\n");
  expect(leave()).toBe(false);

  // Storage full: the draft can't be kept, so leaving the page asks.
  drafts.setFull(true);
  const full = await typed(drafts);
  undo();
  undo = keepDrafts(() => [full]);
  window.dispatchEvent(new Event("pagehide"));
  await settle();
  expect(leave()).toBe(true);
});

test("leaving straight after typing asks, and the pending draft is written meanwhile", async () => {
  const drafts = memoryDrafts();
  const registry = await typed(drafts);
  undo = keepDrafts(() => [registry]);

  // Typing hasn't paused: the newest text is not on the device yet.
  expect(leave()).toBe(true);
  expect(drafts.peek(file)).toBe("mine one\n");
  await settle();
  expect(leave()).toBe(false);
});

test("the desktop app's quit waits for the drafts, then hears they are written", async () => {
  const drafts = memoryDrafts();
  const registry = await typed(drafts);
  let quit: (() => void) | undefined;
  const flushed: string[] = [];
  Reflect.set(window, "ace", {
    drafts: {
      onFlush: (listener: () => void) => {
        quit = listener;
        return () => {};
      },
      flushed: async (kept: boolean) =>
        void flushed.push(`${kept}: ${(await drafts.store.get(file))?.text ?? "none"}`),
    },
  });
  undo = keepDrafts(() => [registry]);
  quit?.();
  await settle();
  await settle();
  expect(flushed).toEqual(["true: mine one\n"]);
  // The desktop app never blocks its own quit with the page's prompt.
  expect(leave()).toBe(false);
});

/** The desktop app's hooks: its quit asks the page, which says whether its drafts are kept. */
function desktopApp() {
  let flush: (() => void) | undefined;
  const acks: boolean[] = [];
  let quits = 0;
  Reflect.set(window, "ace", {
    drafts: {
      onFlush: (listener: () => void) => {
        flush = listener;
        return () => {};
      },
      flushed: async (kept: boolean) => void acks.push(kept),
    },
    app: { quit: async () => void quits++ },
  });
  return { quit: () => flush?.(), acks, quits: () => quits };
}

function answering(...answers: UnsavedAnswer[]) {
  const asked: string[][] = [];
  const ask = async (paths: readonly string[]) => {
    asked.push([...paths]);
    return answers.shift() ?? "cancel";
  };
  return { asked, ask };
}

test("a desktop quit whose drafts can't be kept stops and asks; Cancel stays, Save saves and quits", async () => {
  const drafts = memoryDrafts();
  drafts.setFull(true);
  const disk = fakeDisk({ "store.ts": "one\n" });
  const registry = await typed(drafts, disk);
  const app = desktopApp();
  const person = answering("cancel", "save");
  undo = keepDrafts(() => [registry], { ask: person.ask });

  app.quit();
  await settle();
  expect(app.acks).toEqual([false]);
  expect(person.asked).toEqual([["store.ts"]]);
  expect(app.quits()).toBe(0);
  expect(registry.unsaved()).toHaveLength(1);

  app.quit();
  await settle();
  expect(disk.text("store.ts")).toBe("mine one\n");
  expect(app.quits()).toBe(1);
});

test("Don't save on a desktop quit drops the edits it couldn't keep, then quits", async () => {
  const drafts = memoryDrafts();
  drafts.setFull(true);
  const disk = fakeDisk({ "store.ts": "one\n" });
  const registry = await typed(drafts, disk);
  const app = desktopApp();
  undo = keepDrafts(() => [registry], { ask: answering("discard").ask });

  app.quit();
  await settle();
  expect(app.quits()).toBe(1);
  expect(registry.unsaved()).toEqual([]);
  expect(disk.text("store.ts")).toBe("one\n");

  // The quit that follows hears the drafts are kept: nothing is left to keep.
  app.quit();
  await settle();
  expect(app.acks).toEqual([false, true]);
});
