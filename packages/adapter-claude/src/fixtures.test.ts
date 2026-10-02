import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertExpectations,
  readExpectations,
  readFixture,
  replayFixture,
} from "@ace/adapter-testkit";
import { expect, test } from "vitest";
import { createTranslator } from "./translator.ts";
const directory = fileURLToPath(new URL("../../../fixtures/claude/2.1.286/", import.meta.url));
for (const file of readdirSync(directory).filter((name) => name.endsWith(".jsonl"))) {
  test(`${file} preserves the recorded status timeline`, async () => {
    const fixture = await readFixture(`${directory}/${file}`);
    const expected = await readExpectations(
      `${directory}/${file.replace(".jsonl", ".expect.json")}`,
    );
    const result = replayFixture({
      createTranslator,
      fixture,
      coreConfig: { provider: "claude", silenceMs: 60_000 },
      checkpoints: expected.checkpoints.map((point) => point.t),
    });
    assertExpectations(result, expected);
    expect(
      Object.values(result.final.view.items).filter(
        (item) =>
          item.type === "notice" && item.raw.some((raw) => raw.type === "core.rejected_fact"),
      ),
    ).toEqual([]);
  });
}
