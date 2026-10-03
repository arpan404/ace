import { afterEach, expect, test } from "vitest";
import {
  fixture,
  cleanupRecovery,
  restart,
  resume,
  replaceProvider,
} from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";
import type { Fact } from "@ace/core";

afterEach(cleanupRecovery);

test("context occupancy replaces samples, survives billing updates, and becomes unknown through compaction", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      {
        on: "send",
        frames: [
          frames.frame(
            start,
            {
              type: "context.sample",
              agent: "root",
              usedTokens: 80000,
              windowTokens: 128000,
              sessionId: "session-1",
            },
            end,
          ),
        ],
      },
    ],
    frames,
    { recovery: { contextWindow: () => 100000 } },
  );
  const id = await h.create();
  const root = h.store.getThread(id)?.rootAgentId;
  if (!root) throw new Error("Missing root");
  const meter = () => h.store.snapshotThread(id).contextMeters?.[root];
  expect(meter()).toMatchObject({ usedTokens: 80000, windowTokens: 128000, source: "provider" });
  const sample = frames.frame(
    { type: "context.sample", agent: "root", usedTokens: 81000, sessionId: "session-1" },
    { type: "usage", agent: "root", inputTokens: 900000, outputTokens: 100 },
  );
  h.contexts[0]?.onFrame(sample);
  await h.engine.flush();
  expect(meter()).toMatchObject({ usedTokens: 81000, windowTokens: 128000, source: "provider" });
  const epoch = meter()?.epoch;
  const compaction: Fact = {
    type: "item.upsert",
    agent: "root",
    item: "compact-1",
    draft: { type: "compaction", complete: true },
  };
  h.contexts[0]?.onFrame(frames.frame(compaction));
  await h.engine.flush();
  expect(meter()?.usedTokens).toBeNull();
  expect(meter()?.epoch).toBeGreaterThan(epoch ?? 0);
  const after = meter()?.epoch;
  h.contexts[0]?.onFrame(frames.frame(compaction));
  await h.engine.flush();
  expect(meter()?.epoch).toBe(after);
  h.contexts[0]?.onFrame(
    frames.frame({
      type: "context.sample",
      agent: "root",
      usedTokens: 12000,
      sessionId: "session-1",
    }),
  );
  await h.engine.flush();
  expect(meter()?.usedTokens).toBe(12000);
});

test("new native sessions and model changes cannot display the previous context occupancy", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      {
        on: "send",
        frames: [
          frames.frame(
            start,
            {
              type: "context.sample",
              agent: "root",
              usedTokens: 70000,
              windowTokens: 128000,
              sessionId: "one",
            },
            end,
          ),
        ],
      },
    ],
    frames,
    {
      recovery: {
        contextWindow: (_provider, _instance, model) => (model === "model" ? 100000 : undefined),
      },
    },
  );
  const id = await h.create();
  const root = h.store.getThread(id)?.rootAgentId;
  if (!root) throw new Error("Missing root");
  const meter = () => h.store.snapshotThread(id).contextMeters?.[root];
  h.contexts[0]?.onFrame(
    frames.frame({
      type: "usage",
      agent: "root",
      contextSessionId: "two",
      inputTokens: 2,
      outputTokens: 0,
    }),
  );
  await h.engine.flush();
  expect(meter()).toMatchObject({ usedTokens: null, windowTokens: 100000, source: "catalog" });
  h.contexts[0]?.onFrame(
    frames.frame({
      type: "context.sample",
      agent: "root",
      usedTokens: 5000,
      model: "unknown-model",
      sessionId: "two",
    }),
  );
  await h.engine.flush();
  expect(meter()).toMatchObject({
    usedTokens: 5000,
    windowTokens: null,
    model: "unknown-model",
    source: "unknown",
  });
});

test("subagent context meters stay independent of the root and are restored in snapshots", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      {
        on: "send",
        frames: [
          frames.frame(
            start,
            { type: "context.sample", agent: "root", usedTokens: 100 },
            {
              type: "agent.seen",
              agent: "child",
              parent: "root",
              origin: "provider_subagent",
              fidelity: "full",
              cwd: "/repo",
              native: { provider: "codex" },
              model: "child-model",
            },
            { type: "context.sample", agent: "child", usedTokens: 9000 },
            end,
          ),
        ],
      },
    ],
    frames,
    {
      recovery: {
        contextWindow: (_provider, _instance, model) => (model === "child-model" ? 20000 : 100000),
      },
    },
  );
  const id = await h.create();
  const view = h.store.snapshotThread(id);
  const child = Object.values(view.agents).find((agent) => agent.origin === "provider_subagent");
  if (!view.thread.rootAgentId || !child) throw new Error("Missing agents");
  expect(view.contextMeters?.[view.thread.rootAgentId]).toMatchObject({
    usedTokens: 100,
    windowTokens: 100000,
  });
  expect(view.contextMeters?.[child.id]).toMatchObject({ usedTokens: 9000, windowTokens: 20000 });
});

test("native continuation invalidates a pre-restart occupancy until a fresh provider sample arrives", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      {
        on: "send",
        frames: [
          frames.frame(start, {
            type: "context.sample",
            agent: "root",
            usedTokens: 80000,
            windowTokens: 128000,
            sessionId: "one",
          }),
        ],
      },
    ],
    frames,
  );
  const id = await h.create();
  const root = h.store.getThread(id)?.rootAgentId;
  if (!root) throw new Error("Missing root");
  replaceProvider(h, frames, [{ on: "send", frames: [frames.frame(start)] }]);
  const recovered = await restart(h);
  expect(resume(h, recovered, id).ok).toBe(true);
  await recovered.flush();
  expect(h.store.snapshotThread(id).contextMeters?.[root]?.usedTokens).toBeNull();
  h.contexts.at(-1)?.onFrame(
    frames.frame(
      {
        type: "context.sample",
        agent: "root",
        usedTokens: 9000,
        windowTokens: 128000,
        sessionId: "one",
      },
      end,
    ),
  );
  await recovered.flush();
  expect(h.store.snapshotThread(id).contextMeters?.[root]?.usedTokens).toBe(9000);
});

test("an explicit agent model change clears occupancy without requiring another usage frame", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      {
        on: "send",
        frames: [
          frames.frame(
            start,
            {
              type: "context.sample",
              agent: "root",
              usedTokens: 80000,
              windowTokens: 128000,
              model: "old",
            },
            end,
          ),
        ],
      },
    ],
    frames,
    {
      recovery: {
        contextWindow: (_provider, _instance, model) => (model === "new" ? 64000 : undefined),
      },
    },
  );
  const id = await h.create(),
    root = h.store.getThread(id)?.rootAgentId;
  if (!root) throw new Error("Missing root");
  h.contexts[0]?.onFrame(frames.frame({ type: "agent.linked", agent: "root", model: "new" }));
  await h.engine.flush();
  expect(h.store.snapshotThread(id).contextMeters?.[root]).toMatchObject({
    usedTokens: null,
    windowTokens: 64000,
    model: "new",
    source: "catalog",
  });
});

test("compaction completion invalidates a sample received during the compaction", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      {
        on: "send",
        frames: [
          frames.frame(start, {
            type: "context.sample",
            agent: "root",
            usedTokens: 80000,
            windowTokens: 128000,
          }),
        ],
      },
    ],
    frames,
  );
  const id = await h.create(),
    root = h.store.getThread(id)?.rootAgentId;
  if (!root) throw new Error("Missing root");
  h.contexts[0]?.onFrame(
    frames.frame(
      {
        type: "item.upsert",
        agent: "root",
        item: "compact",
        draft: { type: "compaction", complete: false },
      },
      { type: "context.sample", agent: "root", usedTokens: 79000 },
      {
        type: "item.upsert",
        agent: "root",
        item: "compact",
        draft: { type: "compaction", complete: true },
      },
    ),
  );
  await h.engine.flush();
  expect(h.store.snapshotThread(id).contextMeters?.[root]?.usedTokens).toBeNull();
  h.contexts[0]?.onFrame(
    frames.frame({ type: "context.sample", agent: "root", usedTokens: 9000 }, end),
  );
  await h.engine.flush();
  expect(h.store.snapshotThread(id).contextMeters?.[root]?.usedTokens).toBe(9000);
});
