import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertExpectations, readExpectations, readFixture, replayFixture } from "./index.ts";
import { createTranslator } from "./translator.test-helper.ts";

const fixturePath = fileURLToPath(new URL("./__fixtures__/tiny.jsonl", import.meta.url));
const coreConfig = { provider: "codex", silenceMs: 90_000 } as const;
async function startFixture() {
  const fixture = await readFixture(fixturePath);
  fixture.frames = fixture.frames.slice(0, 1);
  return fixture;
}

describe("replay boundaries", () => {
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "rejects a wrong expected state for own native key %s after loading JSON",
    async (key) => {
      const fixture = await startFixture();
      const result = replayFixture({ fixture, createTranslator, coreConfig, rootKey: key });
      const dir = await mkdtemp(join(tmpdir(), "ace-key-expect-"));
      const path = join(dir, "own.expect.json");
      try {
        await writeFile(
          path,
          JSON.stringify({
            checkpoints: [{ t: 0, thread: "working", agentStates: { [key]: "idle" } }],
            final: { thread: "working", agentStates: { [key]: "working" } },
          }),
        );
        const expected = await readExpectations(path);
        expect(() => assertExpectations(result, expected)).toThrow(
          `at t=0 expected agent ${key} idle, got working`,
        );
        expect(() => assertExpectations(result, { ...expected, checkpoints: [] })).not.toThrow();
        expect(() =>
          assertExpectations(result, {
            checkpoints: [],
            final: { thread: "working", agentStates: { [key]: "idle" } },
          }),
        ).toThrow(`final expected agent ${key} idle, got working`);
        await writeFile(
          path,
          JSON.stringify({
            checkpoints: [],
            final: { thread: "working", agentStates: { [key]: "invalid" } },
          }),
        );
        await expect(readExpectations(path)).rejects.toThrow(key);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it("passes root and thread overrides through translation and projected entities", async () => {
    const result = replayFixture({
      fixture: await startFixture(),
      coreConfig,
      rootKey: "custom-root",
      threadId: "custom-thread",
      createTranslator: (init) => {
        const base = createTranslator(init);
        return {
          ...base,
          translate: (frame, now) => [
            ...base.translate(frame, now),
            {
              type: "item.upsert",
              agent: init.rootKey,
              item: "identity",
              draft: {
                type: "message",
                role: "assistant",
                complete: true,
                parts: [{ type: "text", text: String(init.threadId) }],
              },
            },
          ],
        };
      },
    });
    expect(result.final.view.thread.id).toBe("custom-thread");
    expect(Object.values(result.final.view.agents)).toEqual([
      expect.objectContaining({
        threadId: "custom-thread",
        native: { provider: "codex", nativeId: "custom-root" },
      }),
    ]);
    expect(Object.keys(result.timeline[0]?.agents ?? {})).toEqual(["custom-root"]);
    expect(Object.values(result.final.view.items)).toEqual([
      expect.objectContaining({ parts: [{ type: "text", text: "custom-thread" }] }),
    ]);
  });
  it("emits translator timer items only after the frames at that timestamp", async () => {
    const result = replayFixture({
      fixture: await startFixture(),
      coreConfig,
      createTranslator: (init) => {
        const base = createTranslator(init);
        let ready = false;
        let timerItem = 0;
        return {
          translate(frame, now) {
            ready = true;
            return base.translate(frame, now);
          },
          tick() {
            return [
              {
                type: "item.upsert",
                agent: init.rootKey,
                item: `timer-${++timerItem}`,
                draft: {
                  type: "notice",
                  level: "info",
                  text: ready ? "after frames" : "before frames",
                  complete: true,
                },
              },
            ];
          },
        };
      },
    });
    expect(Object.values(result.final.view.items)).toEqual([
      expect.objectContaining({ type: "notice", text: "after frames" }),
    ]);
  });
  it("isolates original frame envelopes and nested data from translator mutations", async () => {
    const fixture = await startFixture();
    fixture.frames = [
      { seq: 0, t: 0, dir: "recv", channel: "fake", data: { nested: { text: "original" } } },
    ];
    const original = structuredClone(fixture);
    const result = replayFixture({
      fixture,
      coreConfig,
      createTranslator: () => ({
        translate(frame) {
          frame.t = 999;
          const data = frame.data;
          if (
            typeof data === "object" &&
            data !== null &&
            "nested" in data &&
            typeof data.nested === "object" &&
            data.nested !== null &&
            "text" in data.nested
          )
            data.nested.text = "mutated";
          else throw new Error("missing synthetic nested data");
          return [];
        },
        tick: () => [],
      }),
    });
    expect(fixture).toEqual(original);
    expect(result.timeline.map(({ t }) => t)).toEqual([0]);
  });
  it.each([
    {
      name: "duplicate sequences with increasing times",
      frames: [
        { seq: 0, t: 0 },
        { seq: 0, t: 1 },
      ],
    },
    {
      name: "descending sequences with increasing times",
      frames: [
        { seq: 1, t: 0 },
        { seq: 0, t: 1 },
      ],
    },
    {
      name: "descending times with increasing sequences",
      frames: [
        { seq: 0, t: 1 },
        { seq: 1, t: 0 },
      ],
    },
  ])("rejects $name when loading a recording", async ({ frames }) => {
    const fixture = await startFixture();
    const dir = await mkdtemp(join(tmpdir(), "ace-order-"));
    const path = join(dir, "order.jsonl");
    try {
      await writeFile(
        path,
        [
          fixture.header,
          ...frames.map((values) => ({ ...values, dir: "recv", channel: "fake", data: null })),
        ]
          .map((row) => JSON.stringify(row))
          .join("\n"),
      );
      await expect(readFixture(path)).rejects.toThrow("sequence/time moved backwards");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
