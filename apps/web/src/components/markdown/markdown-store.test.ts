import { expect, test } from "vitest";
import { updateInterval } from "./cadence.ts";
import { MarkdownStore } from "./markdown-store.ts";
import { StreamRegistry, type StreamJob, type StreamReply } from "./stream-registry.ts";

/**
 * A store against a real worker registry, with a hand-driven clock and timers, and replies
 * held until the test lets them through, as a busy worker would.
 */
function harness(interval = 80, parkedWeight?: number) {
  let now = 0;
  let registry = new StreamRegistry(() => now);
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  const jobs: StreamJob[] = [];
  const released: string[] = [];
  const held: (() => Promise<StreamReply>)[] = [];
  const store = new MarkdownStore({
    backend: {
      parallel: true,
      run(job) {
        jobs.push(job);
        const reply = Promise.withResolvers<StreamReply>();
        held.push(() => {
          reply.resolve(registry.apply(job));
          return reply.promise;
        });
        return reply.promise;
      },
      local: (job) => registry.apply(job),
      release(stream) {
        released.push(stream);
        registry.release(stream);
      },
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
    ...(parkedWeight === undefined ? {} : { parkedWeight }),
  });
  let notified = 0;
  const unwatch = store.watch("m", () => notified++);
  return {
    store,
    jobs,
    released,
    unwatch,
    notified: () => notified,
    /** The worker answers the oldest job; the store has handled the answer when this resolves. */
    async reply() {
      // The store's own handler was attached first, so it has run once this await resumes.
      await held.shift()?.();
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

test("a message scrolled away and back shows its blocks at once, with no new job", async () => {
  const { store, reply, jobs } = harness();
  const stop = store.watch("x", () => {});
  store.want("x", "# Title\n\nBody", true);
  await reply();
  stop();
  // Mounted again: the first render reads the parked document; asking again sends nothing.
  store.watch("x", () => {});
  expect(store.read("x")?.blocks.map((block) => block.token.type)).toEqual([
    "heading",
    "paragraph",
  ]);
  store.want("x", "# Title\n\nBody", true);
  expect(jobs).toHaveLength(1);
});

test("a final text that arrives while a paced update waits goes at once", async () => {
  const { store, jobs, reply, advance, text } = harness(80);
  store.want("m", "Hello", false);
  await reply();
  advance(5);
  store.want("m", "Hello, wor", false);
  // That update waits for its turn, 75 ms away...
  expect(jobs).toHaveLength(1);
  store.want("m", "Hello, world.", true);
  // ...but the final text doesn't.
  expect(jobs.at(-1)).toEqual({ stream: "m", at: 5, append: ", world.", final: true });
  await reply();
  expect(text()).toBe("Hello, world.");
  // The cancelled wait sends nothing later.
  advance(200);
  expect(jobs).toHaveLength(2);
});

test("unmounting drops queued text, frees the worker's parser and ignores the reply on its way", async () => {
  const { store, jobs, released, reply, advance, unwatch, text } = harness(10);
  store.want("m", "Hello\n\nworld", false);
  await reply();
  const shown = store.read("m");
  advance(20);
  store.want("m", "Hello\n\nworld, and", false);
  // A long replacement queues behind the job in flight.
  store.want("m", "x".repeat(65_000), false);
  unwatch();
  expect(released).toEqual(["m"]);
  await reply();
  // The answer to the job sent before unmounting changes nothing, and nothing more is sent.
  expect(store.read("m")).toBe(shown);
  advance(100);
  expect(jobs).toHaveLength(2);
  // Mounted again, the text goes whole: the worker no longer holds the stream.
  store.watch("m", () => {});
  store.want("m", "Hello\n\nworld, and more", false);
  expect(jobs.at(-1)).toMatchObject({ at: 0, append: "Hello\n\nworld, and more" });
  await reply();
  expect(text()).toBe("Hello | world, and more");
});

test("unwatched documents are kept by what they hold: the oldest go once the budget is spent", async () => {
  // Room for two parked paragraphs of 600 characters: each weighs its text, its blocks three
  // times over (their token trees) and a little more, about 2.7 K.
  const { store, reply } = harness(10, 6_000);
  const park = async (key: string) => {
    const stop = store.watch(key, () => {});
    store.want(key, `${key}: ${"word ".repeat(120)}`, true);
    await reply();
    stop();
  };
  await park("a");
  await park("b");
  await park("c");
  expect(store.read("a")).toBeUndefined();
  expect(store.read("b")).toBeDefined();
  expect(store.read("c")).toBeDefined();
});

test("updates come 10 to 20 times a second: slower when they cost more, and when motion is reduced", () => {
  expect(updateInterval(2, false)).toBe(50);
  expect(updateInterval(20, false)).toBe(80);
  expect(updateInterval(200, false)).toBe(100);
  expect(updateInterval(2, true)).toBe(100);
});
