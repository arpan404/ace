import { afterEach, expect, test } from "vitest";
import type { Item, ThreadId } from "@ace/protocol";
import { transitionHarness } from "./transition-test-support.ts";

/*
 * Context handoff: a thread that moves to another provider continues there with a bounded,
 * quoted excerpt of its conversation, and its transcript marks the switch once. Returning to a
 * provider resumes the session it left with only what happened since. Fake provider sessions
 * over a real temporary SQLite store; no provider CLI runs.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
function setup(options: Parameters<typeof transitionHarness>[0] = {}) {
  const h = transitionHarness(options);
  cleanup.push(h.close);
  return h;
}
type Harness = ReturnType<typeof setup>;

async function send(h: Harness, threadId: ThreadId, text: string) {
  const result = h.command({
    type: "thread.send",
    threadId,
    delivery: "queue",
    input: [{ type: "text", text }],
  });
  expect(result.ok).toBe(true);
  await h.engine.flush();
}

async function switchTo(
  h: Harness,
  threadId: ThreadId,
  provider: "claude" | "codex" | "opencode",
  model: string,
) {
  expect(h.command({ type: "thread.switch", threadId, selection: { provider, model } }).ok).toBe(
    true,
  );
  await h.engine.flush();
}

/** The input that carried `text` to a provider. */
const delivered = (h: Harness, text: string) =>
  h.inputs.find((input) => input.text.split("\n").includes(text));

/** The transcript's handoff markers, in order. */
function markers(h: Harness, id: ThreadId) {
  const view = h.store.snapshotThread(id);
  return view.itemOrder
    .map((itemId) => view.items[itemId])
    .filter(
      (item): item is Extract<Item, { type: "message" }> =>
        item?.type === "message" && item.origin?.kind === "handoff",
    );
}

const closings = (text: string) => text.split("\n</ace_context_handoff>").length - 1;

/** The native session of the provider input that carried `text`. */
const sessionOf = (h: Harness, text: string) => delivered(h, text)?.nativeId;

test("returning to an earlier provider resumes its own session with only what happened since", async () => {
  const h = setup();
  const id = await h.create();
  const codexSession = sessionOf(h, "source history");
  await switchTo(h, id, "claude", "opus");
  await send(h, id, "second ask");
  await switchTo(h, id, "codex", "model-a");
  await send(h, id, "third ask");

  const back = delivered(h, "third ask");
  expect(back?.provider).toBe("codex");
  expect(back?.nativeId).toBe(codexSession);
  expect(closings(back?.text ?? "")).toBe(1);
  expect(back?.text).toContain("You are resuming this conversation");
  expect(back?.text).toContain("user: second ask");
  // Codex's own session already holds the opening ask; only Claude's turn is handed over. (The
  // fake Claude echoes its own input into its answer; that quoted echo is left out here.)
  const handedOver = (back?.text ?? "").replace(
    /answer: <ace_context_handoff[\s\S]*?<\\\/ace_context_handoff>/,
    "",
  );
  expect(handedOver).toContain("user: second ask");
  expect(handedOver).not.toContain("user: source history");
  expect(markers(h, id).at(-1)?.origin).toMatchObject({
    to: { provider: "codex", model: "model-a" },
    sources: [{ provider: "claude", model: "opus" }],
  });
});

test("switching away and straight back resumes the session with no handoff and no marker", async () => {
  const h = setup();
  const id = await h.create();
  const codexSession = sessionOf(h, "source history");
  await switchTo(h, id, "claude", "opus");
  await switchTo(h, id, "codex", "model-a");
  await send(h, id, "same as before");

  const back = delivered(h, "same as before");
  expect(back?.nativeId).toBe(codexSession);
  expect(closings(back?.text ?? "")).toBe(0);
  expect(markers(h, id)).toHaveLength(0);
});

test("a return whose old session is gone opens fresh with the whole conversation, once", async () => {
  const lostSessions = new Set<string>();
  const h = setup({ lostSessions });
  const id = await h.create();
  const codexSession = sessionOf(h, "source history") ?? "";
  await switchTo(h, id, "claude", "opus");
  await send(h, id, "second ask");
  await switchTo(h, id, "codex", "model-a");
  lostSessions.add(codexSession);
  await send(h, id, "third ask");
  await send(h, id, "fourth ask");

  const back = delivered(h, "third ask");
  expect(back?.provider).toBe("codex");
  expect(back?.nativeId).not.toBe(codexSession);
  expect(closings(back?.text ?? "")).toBe(1);
  expect(back?.text).toContain("user: source history");
  expect(back?.text).toContain("user: second ask");
  expect(back?.text).not.toContain("You are resuming");
  expect(closings(delivered(h, "fourth ask")?.text ?? "")).toBe(0);
  expect(markers(h, id)).toHaveLength(2);
  expect(markers(h, id).at(-1)?.origin?.sources).toEqual([
    { provider: "codex", model: "model-a" },
    { provider: "claude", model: "opus" },
  ]);
});

test("a return planned before a daemon restart still resumes the provider's own session", async () => {
  const h = setup();
  const id = await h.create();
  const codexSession = sessionOf(h, "source history");
  await switchTo(h, id, "claude", "opus");
  await send(h, id, "second ask");
  await switchTo(h, id, "codex", "model-a");
  await h.reopen();
  await send(h, id, "after restart");

  const back = delivered(h, "after restart");
  expect(back?.nativeId).toBe(codexSession);
  expect(closings(back?.text ?? "")).toBe(1);
  expect(back?.text).toContain("user: second ask");
});

test("switching again before the agent hears the handoff leaves one marker naming the models that worked", async () => {
  const h = setup();
  const id = await h.create();
  await switchTo(h, id, "claude", "opus");
  await switchTo(h, id, "opencode", "muse");
  await send(h, id, "next ask");

  const shown = markers(h, id);
  expect(shown).toHaveLength(1);
  expect(shown[0]?.origin).toMatchObject({
    to: { provider: "opencode", model: "muse" },
    sources: [{ provider: "codex", model: "model-a" }],
  });
  const input = delivered(h, "next ask");
  expect(input?.provider).toBe("opencode");
  expect(closings(input?.text ?? "")).toBe(1);
});

test("a model change before delivery retargets the waiting marker instead of adding one", async () => {
  const h = setup();
  const id = await h.create();
  await switchTo(h, id, "claude", "opus");
  await switchTo(h, id, "claude", "sonnet");
  await send(h, id, "next ask");

  const shown = markers(h, id);
  expect(shown).toHaveLength(1);
  expect(shown[0]?.origin?.to).toEqual({ provider: "claude", model: "sonnet" });
  expect(delivered(h, "next ask")?.text).toContain("user: source history");
});

test("a handoff waiting for the next message survives a daemon restart and is sent once", async () => {
  const h = setup();
  const id = await h.create();
  await switchTo(h, id, "claude", "opus");
  await h.reopen();
  await send(h, id, "after restart");
  await send(h, id, "and again");

  const first = delivered(h, "after restart");
  expect(first?.provider).toBe("claude");
  expect(closings(first?.text ?? "")).toBe(1);
  expect(first?.text).toContain("user: source history");
  expect(closings(delivered(h, "and again")?.text ?? "")).toBe(0);
});

test("on a long thread the opening ask and the latest exchange reach the new agent within budget", async () => {
  const h = setup();
  const id = await h.create();
  h.emit(
    id,
    { type: "turn.started", agent: "root", nativeTurnId: "busy", trigger: "user" },
    ...Array.from({ length: 240 }, (_, index) => ({
      type: "item.upsert" as const,
      agent: "root",
      item: `step-${index}`,
      draft: {
        type: "message" as const,
        role: "assistant" as const,
        complete: true,
        parts: [{ type: "text" as const, text: `step ${index} ${"x".repeat(400)}` }],
      },
    })),
    { type: "turn.ended", agent: "root", nativeTurnId: "busy", outcome: "completed" },
  );
  await h.engine.flush();
  await switchTo(h, id, "claude", "opus");
  await send(h, id, "what next?");

  const input = delivered(h, "what next?");
  const block = input?.text.slice(0, input.text.indexOf("\n</ace_context_handoff>")) ?? "";
  expect(block).toContain("user: source history");
  expect(block).toContain("step 239 ");
  expect(block).not.toContain("step 0 ");
  expect(block).toMatch(/Earlier items left out: \d+\./);
  expect(Buffer.byteLength(block)).toBeLessThanOrEqual(32768);
});
