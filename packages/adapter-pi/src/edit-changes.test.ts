import type { FileChange } from "@ace/protocol";
import { expect, test } from "vitest";
import { replay } from "./testing/harness.ts";

// What Pi 1.5's edit tool returns in `details.patch` for this edit (generateUnifiedPatch).
const patch =
  "--- src/math.ts\n+++ src/math.ts\n@@ -1,3 +1,7 @@\n export function add(a: number, b: number): number {\n-  return a + b;\n+  return a + b + 0;\n }\n+\n+export function subtract(a: number, b: number): number {\n+  return a - b;\n+}\n";
// The display diff Pi sends beside it, numbered lines rather than a unified patch.
const display =
  " 1 export function add(a: number, b: number): number {\n-2   return a + b;\n+2   return a + b + 0;\n 3 }\n+4 \n+5 export function subtract(a: number, b: number): number {\n+6   return a - b;\n+7 }";
const edits = [
  { oldText: "  return a + b;", newText: "  return a + b + 0;" },
  {
    oldText: "}\n",
    newText: "}\n\nexport function subtract(a: number, b: number): number {\n  return a - b;\n}\n",
  },
];

function editChanges(args: unknown, details: unknown): FileChange[] {
  const h = replay();
  h.recv({ type: "agent_start" });
  h.recv({ type: "tool_execution_start", toolCallId: "e", toolName: "edit", args });
  h.recv({
    type: "tool_execution_end",
    toolCallId: "e",
    result: { content: [{ type: "text", text: "Successfully replaced 2 block(s)." }], details },
  });
  return Object.values(h.state.items).flatMap((item) =>
    item.type === "tool_call" && item.call.detail.kind === "file.edit"
      ? item.call.detail.changes
      : [],
  );
}
const lines = (text: string, sign: "+" | "-") =>
  text.split("\n").filter((line) => line.startsWith(sign) && !line.startsWith(sign.repeat(3)));

test("a Pi edit keeps the patch Pi wrote, so the turn shows its added and removed lines", () => {
  const changes = editChanges(
    { path: "src/math.ts", edits },
    { diff: display, patch, firstChangedLine: 2 },
  );
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({ path: "src/math.ts", kind: "update" });
  const diff = changes[0]?.diff ?? "";
  expect(lines(diff, "+")).toEqual([
    "+  return a + b + 0;",
    "+",
    "+export function subtract(a: number, b: number): number {",
    "+  return a - b;",
    "+}",
  ]);
  expect(lines(diff, "-")).toEqual(["-  return a + b;"]);
});

test("a Pi edit without a patch still carries the text each replacement swapped", () => {
  const changes = editChanges({ path: "src/math.ts", edits }, { diff: display });
  expect(changes).toEqual([
    { path: "src/math.ts", kind: "update", ...edits[0] },
    { path: "src/math.ts", kind: "update", ...edits[1] },
  ]);
});

test("an older Pi edit with one top-level replacement carries its text", () => {
  const changes = editChanges(
    { path: "src/math.ts", oldText: "a + b", newText: "a + b + 0" },
    undefined,
  );
  expect(changes).toEqual([
    { path: "src/math.ts", kind: "update", oldText: "a + b", newText: "a + b + 0" },
  ]);
});
