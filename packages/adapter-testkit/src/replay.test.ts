import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readFixture,
  readExpectations,
  replayFixture,
  assertExpectations,
  type Expectations,
} from "./index.ts";
import { createTranslator } from "./translator.test-helper.ts";

const fixturePath = fileURLToPath(new URL("./__fixtures__/tiny.jsonl", import.meta.url));
const expectationPath = fileURLToPath(new URL("./__fixtures__/tiny.expect.json", import.meta.url));
const coreConfig = { provider: "codex", silenceMs: 90_000 } as const;
async function replay(checkpoints: number[] = []) {
  return replayFixture({
    fixture: await readFixture(fixturePath),
    createTranslator,
    coreConfig,
    checkpoints,
  });
}

describe("recorded replay", () => {
  it("replays every direction in order and samples the complete state at each timestamp", async () => {
    const result = await replay();
    expect(result.timeline.map(({ t, thread }) => [t, thread.state])).toEqual([
      [0, "working"],
      [10, "working"],
      [15, "working"],
      [20, "needs_you"],
      [30, "working"],
      [40, "working"],
      [100, "needs_you"],
      [110, "done"],
    ]);
    expect(result.timeline[3]?.agents).toMatchObject({
      root: { state: "blocked", on: "human" },
      child: { state: "idle" },
    });
    expect(
      Object.values(result.final.view.items).find((item) => item.type === "message"),
    ).toMatchObject({ parts: [{ type: "text", text: "hello10" }], complete: true, createdAt: 10 });
    expect(Object.values(result.final.view.runs).map((run) => [run.trigger, run.state])).toEqual([
      ["user", "completed"],
      ["spawn", "completed"],
    ]);
  });
  it("fires translator timers and core wake expiry between frames at requested checkpoints", async () => {
    const result = await replay([120, 60, 55, 55]);
    expect(
      result.timeline
        .filter(({ t }) => [55, 60, 120].includes(t))
        .map(({ t, thread }) => [t, thread.state]),
    ).toEqual([
      [55, "working"],
      [60, "done"],
      [120, "done"],
    ]);
    expect(
      Object.values(result.final.view.items).find((item) => item.type === "notice"),
    ).toMatchObject({ text: "timer at 55", createdAt: 55 });
    expect(result.timeline.find(({ t }) => t === 55)?.agents.root).toMatchObject({
      state: "working",
    });
    expect(result.timeline.find(({ t }) => t === 60)?.agents.root).toEqual({ state: "idle" });
  });
  it("counts projected items, agents and historical resolved and expired interactions", async () => {
    const result = await replay([55, 60]);
    expect(result.final.agents).toBe(2);
    expect(result.final.items).toEqual({
      artifact: 0,
      message: 1,
      notice: 1,
      reasoning: 0,
      tool_call: 0,
      compaction: 0,
      "delegation.started": 0,
      "delegation.settled": 0,
    });
    expect(result.final.interactions).toEqual({
      resolved: 1,
      expired: 1,
      pending: 0,
      cancelled: 0,
    });
    expect(Object.values(result.final.view.interactions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "resolved",
          resolution: { kind: "approval", optionId: "yes" },
          closedAt: 30,
        }),
        expect.objectContaining({ state: "expired", closedAt: 110 }),
      ]),
    );
    expect(result.final.thread).toEqual(result.final.view.thread.status);
    expect(
      Object.values(result.final.view.agents).find((agent) => agent.native.nativeId === "child")
        ?.parentId,
    ).toBe(result.final.view.thread.rootAgentId);
  });
  it("loads and checks contract files and reports checkpoint mismatches with their time", async () => {
    const expected = await readExpectations(expectationPath);
    const result = await replay(expected.checkpoints.map(({ t }) => t));
    expect(() => assertExpectations(result, expected)).not.toThrow();
    const wrong: Expectations = { ...expected, checkpoints: [{ t: 60, thread: "waiting" }] };
    expect(() => assertExpectations(result, wrong)).toThrow("at t=60 expected waiting, got done");
    expect(() =>
      assertExpectations(result, { ...expected, checkpoints: [{ t: 59, thread: "done" }] }),
    ).toThrow("at t=59 was not replayed");
    expect(() =>
      assertExpectations(result, { ...expected, final: { thread: "done", agents: 3 } }),
    ).toThrow("final expected agents=3, got 2");
    expect(() =>
      assertExpectations(result, {
        ...expected,
        final: { thread: "done", interactions: { resolved: 2 } },
      }),
    ).toThrow("final expected interactions.resolved=2, got 1");
    expect(() =>
      assertExpectations(result, { ...expected, final: { thread: "done", items: { message: 2 } } }),
    ).toThrow("final expected items.message=2, got 1");
    expect(() =>
      assertExpectations(result, {
        ...expected,
        checkpoints: [{ t: 60, thread: "done", agentStates: { root: "working" } }],
      }),
    ).toThrow("at t=60 expected agent root working, got idle");
    expect(() =>
      assertExpectations(result, {
        ...expected,
        checkpoints: [{ t: 60, thread: "done", agentStates: { missing: "idle" } }],
      }),
    ).toThrow("agent missing idle, got missing");
  });
  it("checks waiting reasons for a network retry", async () => {
    const fixture = await readFixture(fixturePath);
    fixture.frames = fixture.frames.slice(0, 1);
    const result = replayFixture({
      fixture,
      coreConfig,
      rootKey: "__proto__",
      createTranslator: (init) => {
        const base = createTranslator(init);
        return {
          ...base,
          translate: (frame, now) => [
            ...base.translate(frame, now),
            { type: "retry", agent: init.rootKey, on: "network" },
          ],
        };
      },
    });
    expect(() =>
      assertExpectations(result, {
        checkpoints: [
          { t: 0, thread: "waiting", on: "network", agentStates: { ["__proto__"]: "blocked" } },
        ],
        final: { thread: "waiting", on: "network", agents: 1 },
      }),
    ).not.toThrow();
    expect(() =>
      assertExpectations(result, {
        checkpoints: [{ t: 0, thread: "waiting", on: "rate_limit" }],
        final: { thread: "waiting" },
      }),
    ).toThrow("at t=0 expected waiting on rate_limit, got network");
  });
  it("rejects negative, fractional and non-finite checkpoint times", async () => {
    const fixture = await readFixture(fixturePath);
    for (const time of [-1, 1.5, NaN])
      expect(() =>
        replayFixture({ fixture, createTranslator, coreConfig, checkpoints: [time] }),
      ).toThrow("checkpoint times");
  });
  it("preserves unknown provider data and gives file/line context for malformed recordings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ace-testkit-"));
    try {
      const fixture = await readFixture(fixturePath);
      expect(fixture.header.extra).toEqual({ kept: true });
      const path = join(dir, "native.jsonl");
      const unknown = {
        seq: 7,
        t: 123,
        dir: "recv",
        channel: "unknown",
        data: { future: [1, { field: "retained" }] },
        futureEnvelope: true,
      };
      await writeFile(
        path,
        `${JSON.stringify(fixture.header)}\r\n\r\n${JSON.stringify(unknown)}\r\n`,
      );
      expect((await readFixture(path)).frames).toEqual([unknown]);
      await writeFile(path, `${JSON.stringify(fixture.header)}\nnot json\n`);
      await expect(readFixture(path)).rejects.toThrow(`${path}:2:`);
      await writeFile(
        path,
        `${JSON.stringify(fixture.header)}\n{"seq":0,"t":0,"dir":"recv","channel":"stdio"}\n`,
      );
      await expect(readFixture(path)).rejects.toThrow(`${path}:2:`);
      await writeFile(path, JSON.stringify({ ...fixture.header, format: "future" }));
      await expect(readFixture(path)).rejects.toThrow(`${path}:1:`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects misspelled expectations and waiting reasons on non-waiting states", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ace-expect-"));
    const path = join(dir, "bad.expect.json");
    try {
      await writeFile(
        path,
        JSON.stringify({ checkpoints: [], final: { thread: "done", agnets: 2 } }),
      );
      await expect(readExpectations(path)).rejects.toThrow(path);
      await writeFile(
        path,
        JSON.stringify({
          checkpoints: [{ t: 0, thread: "done", on: "network" }],
          final: { thread: "done" },
        }),
      );
      await expect(readExpectations(path)).rejects.toThrow("on is only valid for waiting");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
