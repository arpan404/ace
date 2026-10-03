import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readFixture,
  readExpectations,
  replayFixture,
  assertExpectations,
} from "@ace/adapter-testkit";
import { createOpenCodeAdapter } from "./testing/v1/index.ts";
const directory = fileURLToPath(new URL("../../../fixtures/opencode/1.18.33/", import.meta.url));
const adapter = createOpenCodeAdapter();
describe("recorded OpenCode sessions", () => {
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
