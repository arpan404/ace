import { expect, test } from "vitest";
import { updateInterval } from "./cadence.ts";
import { MarkdownStore } from "./markdown-store.ts";
import { StreamRegistry, type StreamJob, type StreamReply } from "./stream-registry.ts";

/**
 * A store against a real worker registry, with a hand-driven clock and timers, and replies
 * held until the test lets them through, as a busy worker would.
 */
function harness(interval = 80) {
  let now = 0;
  let registry = new StreamRegistry(() => now);
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  const jobs: StreamJob[] = [];
  const held: (() => void)[] = [];
  const store = new MarkdownStore({
    backend: {
      parallel: true,
      run(job) {
        jobs.push(job);
        return new Promise<StreamReply>((resolve) => held.push(() => resolve(registry.apply(job))));
      },
      local: (job) => registry.apply(job),
    },
    now: () => now,
    schedule(delayMs, run) {
      const timer = { at: now + delayMs, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    interval: () => interval,
  });
  let notified = 0;
  store.watch("m", () => notified++);
  return {
    store,
    jobs,
    notified: () => notified,
    /** The worker answers the oldest job. */
    async reply() {
      held.shift()?.();
      await new Promise((resolve) => setTimeout(resolve));
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers.splice(0))
        if (timer.live && timer.at <= now) timer.run();
        else if (timer.live) timers.push(timer);
    },
    /** The worker restarted and lost its streams. */
    restart() {
      registry = new StreamRegistry(() => now);
    },
    /** The blocks shown, by their source. */
    text: () =>
      store
        .read("m")
        ?.blocks.map((block) => block.token.raw.trim())
        .join(" | "),
  };
}

test("a new message's first words go to the worker at once, with no wait", () => {
  const { store, jobs } = harness();
  store.want("m", "Hel", false);
  expect(jobs).toEqual([{ stream: "m", at: 0, append: "Hel", final: false }]);
});

test("later updates of a streaming message are paced, and carry only the text it gained", async () => {
  const { store, jobs, reply, advance, text } = harness(80);
  store.want("m", "Hello", false);
  await reply();
  expect(text()).toBe("Hello");
  advance(10);
  store.want("m", "Hello, wor", false);
  store.want("m", "Hello, world.", false);
  // Within the interval nothing goes; the newest text waits for its turn.
  expect(jobs).toHaveLength(1);
  expect(text()).toBe("Hello");
  advance(70);
  expect(jobs.at(-1)).toEqual({ stream: "m", at: 5, append: ", world.", final: false });
  await reply();
  expect(text()).toBe("Hello, world.");
});

test("the final text goes at once, even inside the interval", async () => {
  const { store, jobs, reply, advance, text } = harness(80);
  store.want("m", "Hello", false);
  await reply();
  advance(5);
  store.want("m", "Hello\n\n```ts\nconst a = 1;\n```", true);
  expect(jobs.at(-1)).toMatchObject({ at: 5, final: true });
  await reply();
  expect(store.read("m")?.settled).toBe(2);
  expect(text()).toBe("Hello | ```ts\nconst a = 1;\n```");
});

test("one job is in flight per message: text that arrives meanwhile goes next, newest only", async () => {
  const { store, jobs, reply, advance } = harness(10);
  store.want("m", "a", false);
  store.want("m", "ab", false);
  store.want("m", "abc", false);
  expect(jobs).toHaveLength(1);
  advance(20);
  await reply();
  expect(jobs.at(-1)).toEqual({ stream: "m", at: 1, append: "bc", final: false });
});

test("rewritten text, not an append, is sent whole", async () => {
  const { store, jobs, reply, advance, text } = harness(10);
  store.want("m", "First draft", false);
  await reply();
  advance(20);
  store.want("m", "Second draft, longer", false);
  expect(jobs.at(-1)).toEqual({ stream: "m", at: 0, append: "Second draft, longer", final: false });
  await reply();
  expect(text()).toBe("Second draft, longer");
});

test("a worker that lost the message is sent the whole text and the view catches up", async () => {
  const { store, jobs, reply, advance, restart, text } = harness(10);
  store.want("m", "Para one.\n\n", false);
  await reply();
  restart();
  advance(20);
  store.want("m", "Para one.\n\nPara two.", false);
  await reply();
  expect(jobs.at(-1)).toEqual({
    stream: "m",
    at: 0,
    append: "Para one.\n\nPara two.",
    final: false,
  });
  await reply();
  expect(text()).toBe("Para one. | Para two.");
});

test("blocks that settled keep their objects while the message grows", async () => {
  const { store, reply, advance } = harness(10);
  store.want("m", "Para one.\n\nPara two.\n\nPara three\n", false);
  await reply();
  const first = store.read("m");
  expect(first?.settled).toBe(2);
  advance(20);
  store.want("m", "Para one.\n\nPara two.\n\nPara three\nends here.\n\n- item\n", false);
  await reply();
  const second = store.read("m");
  expect(second?.settled).toBe(3);
  expect(second?.blocks[0]).toBe(first?.blocks[0]);
  expect(second?.blocks[1]).toBe(first?.blocks[1]);
});

test("a message scrolled away and back shows its blocks at once", async () => {
  const { store, reply } = harness();
  store.want("x", "# Title\n\nBody", true);
  const stop = store.watch("x", () => {});
  await reply();
  stop();
  expect(store.read("x")?.blocks.map((block) => block.token.type)).toEqual([
    "heading",
    "paragraph",
  ]);
});

test("updates come 10 to 20 times a second: slower when they cost more, and when motion is reduced", () => {
  expect(updateInterval(2, false)).toBe(50);
  expect(updateInterval(20, false)).toBe(80);
  expect(updateInterval(200, false)).toBe(100);
  expect(updateInterval(2, true)).toBe(100);
});
