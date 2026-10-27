import { expect, test } from "vitest";
import { blockDiff, markdownBlocks, notebookCells } from "./forge-rendered-model.ts";

test("a fenced code block with blank lines inside stays one markdown block", () => {
  const text = "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro\n";
  expect(markdownBlocks(text)).toEqual([
    "Intro",
    "```ts\nconst a = 1;\n\nconst b = 2;\n```",
    "Outro",
  ]);
});

test("a changed block reads as the old one removed and the new one added, in place", () => {
  const changes = blockDiff(["a", "b", "c"], ["a", "B", "c"], (block) => block);
  expect(changes.map((change) => `${change.kind} ${change.item}`)).toEqual([
    "same a",
    "del b",
    "add B",
    "same c",
  ]);
});

test("a notebook's error output loses its terminal colours, and HTML shows as plain text", () => {
  const notebook = notebookCells(
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: "1/0",
          outputs: [
            { output_type: "error", traceback: ["\u001b[31mZeroDivisionError\u001b[0m"] },
            {
              output_type: "display_data",
              data: { "text/html": "<script>alert(1)</script>", "text/plain": "<table>" },
            },
          ],
        },
      ],
    }),
  );
  expect(notebook?.cells[0]?.outputs).toEqual([
    { kind: "text", text: "ZeroDivisionError", error: true },
    { kind: "text", text: "<table>", error: false },
  ]);
  expect(notebookCells("not json")).toBeUndefined();
});
