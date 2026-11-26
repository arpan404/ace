import { createScriptedAdapter } from "@ace/adapter-testkit";
import type { Fact } from "@ace/core";
import type { ProviderAdapter } from "@ace/engine-api";
import { Capabilities } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});

const capabilities = (compaction: boolean, goals = false) =>
  Capabilities.parse({
    steer: false,
    interruptCascades: false,
    resume: true,
    fork: false,
    subagentTranscripts: true,
    backgroundTaskControl: true,
    backgroundVisibility: "full",
    planMode: false,
    tokenUsage: false,
    imageInput: true,
    rewindFiles: false,
    compaction,
    goals,
  });

const compactionItem: Fact = {
  type: "item.upsert",
  agent: "root",
  item: "compact-1",
  draft: {
    type: "compaction",
    complete: true,
    summary: "The earlier turns, summarised by the provider.",
  },
};

test("a compact command asks the provider for its own compaction, and its events become one row", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frames.frame(
            start,
            {
              type: "context.sample",
              agent: "root",
              usedTokens: 80_000,
              windowTokens: 128_000,
            },
            end,
          ),
        ],
      },
      {
        on: "compact",
        frames: [
          frames.frame({ type: "activity", agent: "root", activity: "compacting" }, compactionItem),
        ],
      },
    ],
    frames,
    { capabilities: capabilities(true) },
  );
  closes.push(h.close);
  const id = await h.create();
  const root = h.store.getThread(id)?.rootAgentId;
  if (!root) throw new Error("Missing root");

  expect(h.command({ type: "thread.compact", threadId: id }).ok).toBe(true);
  await h.engine.flush();

  expect(h.adapter.commands.at(-1)).toEqual({ type: "compact" });
  expect(
    Object.values(h.store.snapshotThread(id).items).filter((item) => item.type === "compaction"),
  ).toMatchObject([
    { type: "compaction", summary: "The earlier turns, summarised by the provider." },
  ]);
  // The provider's next sample decides the new occupancy; ace never keeps the old one.
  expect(h.store.snapshotThread(id).contextMeters?.[root]?.usedTokens).toBeNull();
});

test("a provider without native compaction refuses before anything reaches it", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    capabilities: capabilities(false),
  });
  closes.push(h.close);
  const id = await h.create();

  expect(h.command({ type: "thread.compact", threadId: id })).toMatchObject({
    ok: false,
    error: "unsupported_compact",
  });
  await h.engine.flush();
  expect(h.adapter.commands.some((command) => command.type === "compact")).toBe(false);
});

test("a working agent refuses a compact until its turn ends", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames, {
    capabilities: capabilities(true),
  });
  closes.push(h.close);
  const id = await h.create();

  expect(h.command({ type: "thread.compact", threadId: id })).toMatchObject({
    ok: false,
    error: "thread_not_idle",
  });
  await h.engine.flush();
  expect(h.adapter.commands.some((command) => command.type === "compact")).toBe(false);
});

test("a second compact while one is pending asks the provider once, not twice", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "compact", frames: [frames.frame(compactionItem)] },
    ],
    frames,
    { capabilities: capabilities(true) },
  );
  closes.push(h.close);
  const id = await h.create();

  // The ack returns before any provider frame: the second click must not become a second ask.
  expect(h.command({ type: "thread.compact", threadId: id }).ok).toBe(true);
  expect(h.command({ type: "thread.compact", threadId: id })).toMatchObject({
    ok: false,
    error: "thread_not_idle",
  });
  await h.engine.flush();
  expect(h.adapter.commands.filter((command) => command.type === "compact")).toHaveLength(1);
});

/** A provider whose goal change waits, so a control can be held while another lane runs. */
function slowGoalProvider(frames: ReturnType<typeof scriptFrames>, entered: () => void) {
  const release = Promise.withResolvers<void>();
  const scripted = createScriptedAdapter({
    provider: "codex",
    nativeSessionId: "native-1",
    capabilities: capabilities(true, true),
    createTranslator: () => ({ translate: (frame) => frames.translate(frame), tick: () => [] }),
    steps: [{ on: "send", frames: [frames.frame(start, end)] }, { on: "goal" }],
  });
  const adapter: ProviderAdapter = {
    ...scripted,
    async openSession(ctx) {
      const session = await scripted.openSession(ctx);
      const send = session.send.bind(session);
      const setGoal = session.setGoal?.bind(session);
      let opening = true;
      return Object.assign(session, {
        async send(...args: Parameters<typeof send>) {
          if (opening) {
            opening = false;
            return send(...args);
          }
          // The person's next turn starts without consuming the script's cursor.
          await ctx.onFrame(frames.frame(start));
        },
        async setGoal(change: Parameters<NonNullable<typeof setGoal>>[0]) {
          entered();
          await release.promise;
          return setGoal?.(change);
        },
      });
    },
  };
  return { adapter, scripted, release };
}

test("a compaction admitted while idle never lands in a turn that started before it ran", async () => {
  const frames = scriptFrames();
  const entered = Promise.withResolvers<void>();
  const { adapter, scripted, release } = slowGoalProvider(frames, () => entered.resolve());
  const h = await harness([], frames, {
    nativeAdapter: adapter,
    capabilities: capabilities(true, true),
  });
  closes.push(h.close);
  const id = await h.create();
  try {
    // A control ahead of the compact holds the controls lane.
    expect(
      h.command({ type: "thread.goal.set", threadId: id, change: { objective: "Ship it" } }).ok,
    ).toBe(true);
    await entered.promise;
    // Admitted while the root is idle, as the person clicking Compact sees it.
    expect(h.command({ type: "thread.compact", threadId: id }).ok).toBe(true);
    // Then the person sends, and that turn starts before the compaction reaches the provider.
    expect(
      h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "next" }] }).ok,
    ).toBe(true);
    for (let wait = 0; wait < 400 && h.store.getThread(id)?.status.state !== "working"; wait++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.store.getThread(id)?.status.state).toBe("working");
  } finally {
    release.resolve();
  }
  await h.engine.flush();

  // The provider's own compaction is never pushed into a running turn.
  expect(scripted.commands.filter((command) => command.type === "compact")).toEqual([]);
  const notice = Object.values(h.store.snapshotThread(id).items).find(
    (item) => item.type === "notice" && item.commandId !== undefined,
  );
  expect(notice).toMatchObject({ type: "notice", title: "Couldn't compact the context" });
});
