import {
  IconsResolveResponse,
  ThreadId,
  type IconResult,
  type IconsReadResponse,
} from "@ace/protocol";
import { expect, test } from "vitest";
import { ToolIconCache } from "./tool-icons.ts";

const thread = ThreadId.parse("t");
const ref = (letter: string) => letter.repeat(64);

/** A daemon that answers per step from `answers`; `offline` fails resolving outright. */
function daemon(answers: Record<string, IconResult>) {
  const calls: string[] = [];
  const state = { offline: false, now: 0 };
  const timers: (() => void)[] = [];
  return {
    calls,
    state,
    timers,
    now: () => state.now,
    schedule: (run: () => void) => {
      timers.push(run);
    },
    async resolve(threadId: ThreadId, itemIds: string[]) {
      calls.push(`resolve:${itemIds.join(",")}`);
      if (state.offline) throw new Error("offline");
      return IconsResolveResponse.parse({
        type: "icons.resolve",
        requestId: "r",
        threadId,
        icons: itemIds.map((id) => answers[id] ?? { state: "none" }),
      });
    },
    async read(id: string): Promise<IconsReadResponse> {
      calls.push(`read:${id.slice(0, 1)}`);
      return { type: "icons.read", requestId: "r", ref: id, mimeType: "image/png", data: "UE5H" };
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Mutations: one request per row, or reading the same PNG twice.
test("rows shown together resolve in one batch and share one read per image", async () => {
  const d = daemon({
    open: { state: "found", ref: ref("a") },
    click: { state: "found", ref: ref("a") },
  });
  const cache = new ToolIconCache(d);
  let changes = 0;
  cache.subscribe(() => changes++);
  for (const id of ["open", "click", "shell", "open"]) cache.load(thread, id);
  expect(cache.image(thread, "open")).toBeUndefined();
  await settle();
  expect(d.calls).toEqual(["resolve:open,click,shell", "read:a"]);
  expect(cache.image(thread, "open")).toBe("data:image/png;base64,UE5H");
  expect(cache.image(thread, "click")).toBe("data:image/png;base64,UE5H");
  expect(cache.image(thread, "shell")).toBeNull();
  expect(changes).toBeGreaterThan(0);
  cache.load(thread, "open");
  await settle();
  expect(d.calls).toHaveLength(2);
});

test("a step that already carries its icon's hash skips resolving", async () => {
  const d = daemon({});
  const cache = new ToolIconCache(d);
  cache.load(thread, "open", ref("b"));
  await settle();
  expect(d.calls).toEqual(["read:b"]);
  expect(cache.image(thread, "open")).toMatch(/^data:image\/png/);
});

// Mutation: caching a passing failure as "no icon" for the session.
test("an icon that may come later is asked again after a while, not remembered as none", async () => {
  const answers: Record<string, IconResult> = { open: { state: "later" } };
  const d = daemon(answers);
  const cache = new ToolIconCache({ ...d, retryMs: 1000 });
  cache.load(thread, "open");
  await settle();
  expect(cache.image(thread, "open")).toBeUndefined();
  // Too soon: not asked again.
  cache.load(thread, "open");
  await settle();
  expect(d.calls).toHaveLength(1);
  answers.open = { state: "found", ref: ref("c") };
  d.state.now = 1001;
  cache.load(thread, "open");
  await settle();
  expect(cache.image(thread, "open")).toMatch(/^data:image\/png/);
});

test("an unanswered batch is asked again later too", async () => {
  const d = daemon({ open: { state: "found", ref: ref("a") } });
  d.state.offline = true;
  const cache = new ToolIconCache({ ...d, retryMs: 1000 });
  cache.load(thread, "open");
  await settle();
  expect(cache.image(thread, "open")).toBeUndefined();
  d.state.offline = false;
  d.state.now = 2000;
  cache.load(thread, "open");
  await settle();
  expect(cache.image(thread, "open")).toMatch(/^data:image\/png/);
});

// Mutation: a row only learning its icon's wait is over on some later, unrelated render.
test("rows hear when an icon's wait is over, and asking then reads it", async () => {
  const answers: Record<string, IconResult> = { open: { state: "later" } };
  const d = daemon(answers);
  const cache = new ToolIconCache({ ...d, retryMs: 1000 });
  let changes = 0;
  cache.subscribe(() => changes++);
  cache.load(thread, "open");
  await settle();
  expect(cache.waiting(thread, "open")).toBe(true);
  answers.open = { state: "found", ref: ref("c") };
  d.state.now = 1000;
  const before = changes;
  for (const run of d.timers.splice(0)) run();
  expect(changes).toBeGreaterThan(before);
  expect(cache.waiting(thread, "open")).toBe(false);
  cache.load(thread, "open");
  await settle();
  expect(cache.image(thread, "open")).toMatch(/^data:image\/png/);
});
