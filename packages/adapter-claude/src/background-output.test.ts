import { fileURLToPath } from "node:url";
import { readFixture, replayFixture } from "@ace/adapter-testkit";
import { expect, test } from "vitest";
import { createTranslator } from "./translator.ts";

const fixture = fileURLToPath(
  new URL("../../../fixtures/claude/2.1.286/background-shell.jsonl", import.meta.url),
);

test("a background command keeps the output file Claude names in the call's result, which finds its processes", async () => {
  const result = replayFixture({
    createTranslator,
    fixture: await readFixture(fixture),
    coreConfig: { provider: "claude", silenceMs: 60_000 },
  });
  const tasks = Object.values(result.final.view.backgroundTasks);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]?.outputPath).toMatch(/\/tasks\/bblqdt0o5\.output$/);
  // Claude wakes the agent when it ends: nothing says it won't.
  expect(tasks[0]?.wakesAgent).toBeUndefined();
});
