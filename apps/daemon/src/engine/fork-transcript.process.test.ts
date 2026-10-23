import { afterEach, expect, test } from "vitest";
import type { Item, ThreadId } from "@ace/protocol";
import { transitionHarness } from "./transition-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function setup(options: Parameters<typeof transitionHarness>[0] = {}) {
  const h = transitionHarness(options);
  cleanup.push(h.close);
  return h;
}

/** A thread's messages as the transcript reads them: oldest first, with their words. */
function messages(h: ReturnType<typeof setup>, id: ThreadId) {
  const page = h.store.readItemPage(id, Number.MAX_SAFE_INTEGER, 200);
  return page.items.flatMap((item: Item) =>
    item.type === "message"
      ? [
          {
            role: item.role,
            text: item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
            inherited: item.inherited,
            // A long text reads as its preview; its stream holds the whole of it.
            length: item.parts.reduce(
              (sum, part) =>
                part.type === "text"
                  ? sum + Math.max(part.text.length, (part.source?.bytes ?? 0) / 2)
                  : sum,
              0,
            ),
          },
        ]
      : [],
  );
}

async function send(h: ReturnType<typeof setup>, id: ThreadId, text: string) {
  const result = h.command({
    type: "thread.send",
    threadId: id,
    input: [{ type: "text", text }],
    delivery: "queue",
  });
  if (!result.ok) throw new Error(result.error);
  await h.engine.flush();
}

test("a fork's transcript opens on the source's asks and answers, then its own", async () => {
  const h = setup();
  const source = await h.create();
  const fork = await h.fork(source);
  const sourceMessages = messages(h, source);
  const forkMessages = messages(h, fork);
  const words = (list: typeof forkMessages) => list.map(({ role, text }) => ({ role, text }));
  expect(words(forkMessages.slice(0, 2))).toEqual(words(sourceMessages));
  expect(forkMessages.slice(0, 2).every((message) => message.inherited?.threadId === source)).toBe(
    true,
  );
  // Then the fork's own answer, which is its own work.
  const own = forkMessages.slice(2);
  expect(own.map((message) => message.inherited)).toEqual([undefined]);
  expect(own[0]?.text).toContain("continue fork");
  // The source is untouched, and the fork running never makes it read as working.
  expect(messages(h, source)).toEqual(sourceMessages);
  expect(h.store.getThread(source)?.status.state).toBe("done");
});

test("a fork from an earlier turn copies only the conversation up to that turn", async () => {
  const h = setup();
  const source = await h.create();
  const first = h.finishedRun(source);
  await send(h, source, "a later ask");
  const fork = await h.fork(source, { type: "turn", runId: first.id });
  const copied = messages(h, fork).filter((message) => message.inherited);
  expect(copied.map((message) => message.text)).toEqual([
    "source history",
    expect.stringContaining("answer: source history"),
  ]);
});

test("a long answer is copied whole, not as its preview", async () => {
  const h = setup();
  const source = await h.create();
  const long = "x".repeat(20_000);
  await send(h, source, long);
  const fork = await h.fork(source);
  const copied = messages(h, fork).filter((message) => message.inherited);
  expect(copied.map((message) => message.length)).toContain(long.length);
});

test("a native fork whose provider brings its turns along copies nothing", async () => {
  const h = setup({ native: true, forkTranscript: true });
  const source = await h.create();
  const fork = await h.fork(source);
  expect(h.store.getThread(fork)?.lineage?.mode).toBe("native");
  expect(messages(h, fork).filter((message) => message.inherited)).toEqual([]);
});

test("a native fork whose provider keeps its turns private still shows them", async () => {
  const h = setup({ native: true });
  const source = await h.create();
  const fork = await h.fork(source);
  expect(h.store.getThread(fork)?.lineage?.mode).toBe("native");
  expect(
    messages(h, fork)
      .filter((message) => message.inherited)
      .map((m) => m.text),
  ).toEqual(["source history", expect.stringContaining("answer: source history")]);
});
