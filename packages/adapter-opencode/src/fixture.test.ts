import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readFixture,
  readExpectations,
  replayFixture,
  assertExpectations,
} from "@ace/adapter-testkit";
import { createOpenCodeAdapter as createLegacyAdapter } from "./testing/v1/index.ts";
import { createOpenCodeAdapter } from "./index.ts";
const versions = [
  { path: "1.18.33", adapter: createLegacyAdapter() },
  { path: "2.0.22/muse-spark-1.3-contributor", adapter: createOpenCodeAdapter() },
];
for (const version of versions) {
  const directory = fileURLToPath(
    new URL(`../../../fixtures/opencode/${version.path}/`, import.meta.url),
  );
  const adapter = version.adapter;
  describe(`recorded OpenCode ${version.path} sessions`, () => {
    for (const name of readdirSync(directory).filter((n) => n.endsWith(".jsonl"))) {
      it(`${name} preserves its status timeline and final tree`, async () => {
        const fixture = await readFixture(`${directory}${name}`);
        const expected = await readExpectations(
          `${directory}${name.replace(".jsonl", ".expect.json")}`,
        );
        const result = replayFixture({
          createTranslator: adapter.createTranslator,
          fixture,
          coreConfig: { provider: "opencode", liveness: "transport", silenceMs: 25_000 },
          checkpoints: expected.checkpoints.map((c) => c.t),
        });
        assertExpectations(result, expected);
        expect(
          Object.values(result.final.view.items).filter(
            (i) => i.type === "notice" && i.level === "warning",
          ),
        ).toEqual([]);
      });
    }
  });
}

it("the recorded v2 read retains its native file path in canonical tool details", async () => {
  const fixture = await readFixture(
    fileURLToPath(
      new URL(
        "../../../fixtures/opencode/2.0.22/muse-spark-1.3-contributor/tool-read.jsonl",
        import.meta.url,
      ),
    ),
  );
  const result = replayFixture({
    createTranslator: createOpenCodeAdapter().createTranslator,
    fixture,
    coreConfig: { provider: "opencode", liveness: "transport", silenceMs: 25_000 },
  });
  const reads = Object.values(result.final.view.items).filter(
    (item) => item.type === "tool_call" && item.call.kind === "file.read",
  );
  expect(reads).toEqual([
    expect.objectContaining({
      call: expect.objectContaining({
        status: "succeeded",
        detail: { kind: "file.read", path: "src/math.ts" },
      }),
    }),
  ]);
});

it("the recorded v2 question retains both keyed answers and the multi-select choice", async () => {
  const fixture = await readFixture(
    fileURLToPath(
      new URL(
        "../../../fixtures/opencode/2.0.22/muse-spark-1.3-contributor/question.jsonl",
        import.meta.url,
      ),
    ),
  );
  const result = replayFixture({
    createTranslator: createOpenCodeAdapter().createTranslator,
    fixture,
    coreConfig: { provider: "opencode", liveness: "transport", silenceMs: 25_000 },
  });
  expect(Object.values(result.final.view.interactions)).toEqual([
    expect.objectContaining({
      state: "resolved",
      request: expect.objectContaining({
        kind: "question",
        questions: [
          expect.objectContaining({ id: "q0", multiSelect: false }),
          expect.objectContaining({ id: "q1", multiSelect: true }),
        ],
      }),
      resolution: { kind: "question", answers: { q0: ["Tabs"], q1: ["Tests"] } },
    }),
  ]);
});
