import { expect, test } from "vitest";
import { ItemId } from "@ace/protocol";
import { emptyTurnDigest, mergeTurnDigests } from "./index.ts";

function* turns() {
  for (let turn = 1; turn <= 80; turn++)
    yield {
      ...emptyTurnDigest(),
      commandsRun: 1,
      commandsFailed: Number(turn === 80),
      inputTokens: 100,
      outputTokens: 20,
      files: [{ path: `src/file-${turn}.ts`, added: turn === 1 ? null : 2, removed: 1 }],
      commands: [
        {
          itemId: ItemId.parse(`command-${turn}`),
          command: `inspect ${turn}`,
          failed: turn === 80,
        },
      ],
    };
}

// Mutation cases: truncate exact totals with detail previews; append duplicate command detail;
// turn unknown file line counts into zero. Not executed (tests run at merge).
test("combined catch-up keeps exact totals while capping file and command previews", () => {
  const digest = mergeTurnDigests(turns());
  expect(digest.commandsRun).toBe(80);
  expect(digest.commandsFailed).toBe(1);
  expect(digest.inputTokens).toBe(8000);
  expect(digest.outputTokens).toBe(1600);
  expect(digest.files).toHaveLength(64);
  expect(digest.commands).toHaveLength(64);
  expect(digest.truncated).toBe(true);
  expect(digest.files.find((file) => file.path === "src/file-1.ts")?.added).toBeNull();
});

test("authoritative command detail replaces its earlier preview in a range summary", () => {
  const itemId = ItemId.parse("command");
  const digest = mergeTurnDigests([
    {
      ...emptyTurnDigest(),
      commandsRun: 1,
      commands: [{ itemId, command: "inspect", failed: false }],
    },
    {
      ...emptyTurnDigest(),
      commandsFailed: 1,
      commands: [{ itemId, command: "inspect", failed: true, exitCode: 1 }],
    },
  ]);
  expect(digest.commands).toEqual([{ itemId, command: "inspect", failed: true, exitCode: 1 }]);
  expect(digest.commandsRun).toBe(1);
  expect(digest.commandsFailed).toBe(1);
});
