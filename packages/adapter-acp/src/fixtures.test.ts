import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import {
  readFixture,
  readExpectations,
  replayFixture,
  assertExpectations,
} from "@ace/adapter-testkit";
import { cursorAdapter } from "./index.ts";
const directory = fileURLToPath(
  new URL("../../../fixtures/cursor/2026.09.26-dd393fe/", import.meta.url),
);
for (const name of readdirSync(directory).filter((f) => f.endsWith(".jsonl"))) {
  it(`replays ${name} with correct status checkpoints`, async () => {
    const fixture = await readFixture(`${directory}/${name}`);
    const expectations = await readExpectations(
      `${directory}/${name.replace(".jsonl", ".expect.json")}`,
    );
    const result = replayFixture({
      fixture,
      createTranslator: (init) => cursorAdapter.createTranslator(init),
      coreConfig: { provider: "cursor", silenceMs: 90_000 },
      checkpoints: expectations.checkpoints.map((point) => point.t),
    });
    assertExpectations(result, expectations);
  });
}
