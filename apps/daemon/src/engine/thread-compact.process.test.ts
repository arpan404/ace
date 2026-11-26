import type { Fact } from "@ace/core";
import { Capabilities } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});

const capabilities = (compaction: boolean) =>
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
