import { afterEach, expect, test } from "vitest";
import type { Item, ThreadId } from "@ace/protocol";
import { trimmedText } from "@ace/handoff";
import { maxInheritedTextBytes } from "./fork-history.ts";
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
            at: item.createdAt,
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

test("a copy keeps when it was said; an answer past the copy's budget is cut and says so", async () => {
  const h = setup();
  const source = await h.create();
  const said = messages(h, source)[0];
  await send(h, source, "y".repeat(40_000));
  const fork = await h.fork(source);
  const copied = messages(h, fork).filter((message) => message.inherited);
  expect(copied[0]?.inherited?.at).toBe(said?.at);
  // Both the long ask and its answer are cut to the budget, then say the rest is in the source.
  const cut = maxInheritedTextBytes / 2 + trimmedText.length;
  expect(copied.filter((message) => message.length === cut)).toHaveLength(2);
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

test("a native fork that leaves for another provider before it opens still shows its history", async () => {
  const h = setup({
    native: true,
    forkTranscript: true,
    beforeFork: async () => {
      throw new Error("Native fork unavailable");
    },
  });
  const source = await h.create();
  const fork = await h.fork(source);
  expect(messages(h, fork).filter((message) => message.inherited)).toEqual([]);
  const result = h.command({
    type: "thread.switch",
    threadId: fork,
    selection: { provider: "claude", model: "model-a" },
  });
  expect(result.ok).toBe(true);
  await h.engine.flush();
  expect(
    messages(h, fork)
      .filter((message) => message.inherited)
      .map((m) => m.text),
  ).toEqual(["source history", expect.stringContaining("answer: source history")]);
});

test("a native fork that moves to another account before it opens shows and hands over its history", async () => {
  const h = setup({
    native: true,
    forkTranscript: true,
    beforeFork: async () => {
      throw new Error("Native fork unavailable");
    },
  });
  const source = await h.create();
  const fork = await h.fork(source);
  expect(messages(h, fork).filter((message) => message.inherited)).toEqual([]);
  const result = h.command({
    type: "thread.switch",
    threadId: fork,
    selection: { provider: "codex", model: "model-a", instanceId: "account-b" },
  });
  expect(result.ok).toBe(true);
  await h.engine.flush();
  expect(
    messages(h, fork)
      .filter((message) => message.inherited)
      .map((m) => m.text),
  ).toEqual(["source history", expect.stringContaining("answer: source history")]);
  // The next message reaches the new account with the conversation it continues.
  await send(h, fork, "carry on");
  const delivered = h.inputs.findLast((input) => input.text.includes("carry on"));
  expect(delivered?.text).toContain("user: source history");
});

test("turns a provider's native fork brings along read as the source's history", async () => {
  const h = setup({
    native: true,
    forkTranscript: true,
    forkReplay: [
      {
        type: "item.upsert",
        agent: "root",
        item: "replayed-ask",
        draft: {
          type: "message",
          role: "user",
          complete: true,
          parts: [{ type: "text", text: "old ask" }],
        },
      },
      {
        type: "item.upsert",
        agent: "root",
        item: "replayed-step",
        draft: {
          type: "tool_call",
          complete: true,
          call: {
            kind: "shell",
            title: "ls",
            status: "succeeded",
            detail: { kind: "shell", command: "ls" },
          },
        },
      },
    ],
  });
  const source = await h.create();
  const fork = await h.fork(source);
  const replayed = messages(h, fork).find((message) => message.text === "old ask");
  expect(replayed?.inherited).toEqual({ threadId: source });
  // Its steps too: everything it brought along is the source's.
  const step = h.store
    .readItemPage(fork, Number.MAX_SAFE_INTEGER, 200)
    .items.find((item) => item.type === "tool_call");
  expect(step?.inherited).toEqual({ threadId: source });
  // The fork's own answer, after it opened, is its own.
  expect(messages(h, fork).at(-1)?.inherited).toBeUndefined();
});

test("a merge can't cite what the fork copied from its source", async () => {
  const h = setup();
  const source = await h.create();
  const fork = await h.fork(source);
  const copy = h.store
    .readItemPage(fork, Number.MAX_SAFE_INTEGER, 200)
    .items.find((item) => item.type === "message" && item.inherited && item.role === "assistant");
  if (!copy) throw new Error("No copy");
  const result = h.command({
    type: "thread.merge",
    threadId: fork,
    summary: "Bring the source's answer back",
    citations: [{ threadId: fork, itemId: copy.id }],
  });
  expect(result).toMatchObject({ ok: false, error: "Citation is the source's own message" });
});
