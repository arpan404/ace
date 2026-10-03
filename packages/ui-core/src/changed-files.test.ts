import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { threadFiles, writtenText } from "./changed-files.ts";

const thread = { id: "t", title: "Refund tax", workspaceId: "billing-api" };
const edit = (id: string, at: number, changes: unknown[]): Item =>
  Item.parse({
    type: "tool_call",
    id,
    agentId: "root",
    createdAt: at,
    complete: true,
    call: {
      id,
      agentId: "root",
      kind: "file.edit",
      title: "Edit",
      status: "succeeded",
      startedAt: at,
      endedAt: at + 1,
      detail: { kind: "file.edit", changes },
      raw: [],
    },
  });

test("a thread's files group its edits by path, a move under its new path", () => {
  const files = threadFiles(thread, [
    edit("a", 10, [{ path: "src/tax.ts", kind: "update", diff: "@@\n-a\n+b" }]),
    edit("b", 20, [
      { path: "src/tax.ts", kind: "update", diff: "@@\n-b\n+c" },
      { path: "src/old.ts", kind: "move", movePath: "src/new.ts" },
    ]),
  ]);
  expect(files.map((file) => [file.path, file.changes.length, file.updatedAt])).toEqual([
    ["src/tax.ts", 2, 21],
    ["src/new.ts", 1, 21],
  ]);
  expect(files[0]).toMatchObject({ threadTitle: "Refund tax", workspaceId: "billing-api" });
});

test("only a file the agent wrote whole can be downloaded as written", () => {
  const [created, edited, removed] = threadFiles(thread, [
    edit("a", 1, [
      { path: "src/tax.test.ts", kind: "add", newText: "test('rounds')\n" },
      { path: "src/tax.ts", kind: "update", oldText: "a", newText: "b" },
      { path: "docs/old.md", kind: "delete", oldText: "gone" },
    ]),
  ]);
  expect(created && writtenText(created)).toBe("test('rounds')\n");
  expect(edited && writtenText(edited)).toBeUndefined();
  expect(removed && writtenText(removed)).toBeUndefined();
});
