import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  assertExpectations,
  readExpectations,
  readFixture,
  replayFixture,
} from "@ace/adapter-testkit";
import { createCodexTranslator } from "./translator.ts";
const directory = new URL("../../../fixtures/codex/0.159.1/", import.meta.url);
for (const name of readdirSync(directory).filter((name) => name.endsWith(".jsonl")))
  test(`preserves the status timeline in ${name}`, async () => {
    const fixture = await readFixture(fileURLToPath(new URL(name, directory)));
    const expected = await readExpectations(
      fileURLToPath(new URL(name.replace(".jsonl", ".expect.json"), directory)),
    );
    const result = replayFixture({
      createTranslator: createCodexTranslator,
      fixture,
      coreConfig: { provider: "codex", silenceMs: 90_000 },
      checkpoints: expected.checkpoints.map((c) => c.t),
    });
    assertExpectations(result, expected);
    const rejected = Object.values(result.final.view.items).filter(
      (item) => item.type === "notice" && item.raw.some((r) => r.type === "core.rejected_fact"),
    );
    expect(rejected).toEqual([]);
  });
