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

/*
 * Hot exit (spec 50): unsaved text reaches the device when the page hides or the desktop app
 * quits, and only text that can't be kept makes leaving the page ask.
 */

const file = { root: "m1/t1", path: "store.ts" };
let undo: (() => void) | undefined;
afterEach(() => {
  undo?.();
  undo = undefined;
  Reflect.deleteProperty(window, "ace");
});

async function typed(drafts: ReturnType<typeof memoryDrafts>) {
  await ready();
  const registry = createBufferRegistry({
    files: fakeDisk({ "store.ts": "one\n" }).port,
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
      flushed: async () => void flushed.push((await drafts.store.get(file))?.text ?? "none"),
    },
  });
  undo = keepDrafts(() => [registry]);
  quit?.();
  await settle();
  await settle();
  expect(flushed).toEqual(["mine one\n"]);
  // The desktop app never blocks its own quit with the page's prompt.
  expect(leave()).toBe(false);
});
