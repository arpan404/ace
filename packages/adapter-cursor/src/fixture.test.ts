import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  readFixture,
  replayFixture,
  readExpectations,
  assertExpectations,
} from "@ace/adapter-testkit";
import { createCursorAdapter } from "./index.ts";

const path = fileURLToPath(
  new URL("../../../fixtures/cursor-sdk/1.0.35/composer-2.5/full-access.jsonl", import.meta.url),
);
const replay = async () =>
  replayFixture({
    fixture: await readFixture(path),
    createTranslator: createCursorAdapter().createTranslator,
    coreConfig: { provider: "cursor", silenceMs: 90000 },
  });

it("the recorded failed shell stays failed after the later successful read and finished root", async () => {
  const result = await replay();
  assertExpectations(result, await readExpectations(path.replace(".jsonl", ".expect.json")));
  const calls = Object.values(result.final.view.items).flatMap((item) =>
    item.type === "tool_call" ? [item.call] : [],
  );
  expect(calls.map((call) => call.status)).toEqual(["succeeded", "failed", "succeeded"]);
  const shells = calls.filter((call) => call.detail?.kind === "shell");
  expect(shells.map((call) => call.detail)).toMatchObject([
    {
      kind: "shell",
      exitCode: 1,
      output: { tail: "cat: <WORKSPACE>/scratch.txt: No such file or directory\n", bytes: 56 },
    },
    { kind: "shell", exitCode: 0, output: { bytes: 100 } },
  ]);
  expect(Object.values(result.final.view.interactions)).toHaveLength(0);
});

it("the recorded fragment messages, deltas and terminal result render one copy of each assistant passage", async () => {
  const result = await replay();
  const messages = Object.values(result.final.view.items).flatMap((item) =>
    item.type === "message" && item.role === "assistant"
      ? [item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")]
      : [],
  );
  expect(messages).toHaveLength(3);
  expect(messages[0]).toBe("Creating `scratch.txt` and reading it with a shell command.\n\n\n");
  expect(messages[1]).toBe("Verifying the file exists and retrying the read:\n\n\n");
  expect(messages[2]).toMatch(/^Done\.\n\n\*\*Created\*\* `scratch.txt`/);
  expect(messages.join("").match(/Done\./g)).toHaveLength(1);
});

it("the recorded turn usage, usage message and terminal accounting contribute one cumulative counter", async () => {
  const result = await replay();
  expect(Object.values(result.final.view.usage)).toMatchObject([
    {
      inputTokens: 24592,
      outputTokens: 468,
      cachedInputTokens: 10272,
      cacheWriteTokens: 0,
      counterMode: "cumulative",
      billingMode: "unknown",
    },
  ]);
  expect(Object.values(result.final.view.usage)).toHaveLength(1);
});
