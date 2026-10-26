import { withTask } from "@ace/ui-core/forge-rich";
import { expect, test } from "vitest";
import { richBlocks, type RichBlock } from "./forge-rich.ts";

/* GitHub text as the phone draws it: blocks, runs and media, decided before Swift sees it. */

const repo = "https://github.com/acme/ace";
const blocks = (source: string) => richBlocks(source, "github.com", repo);
const text = (block: RichBlock | undefined) =>
  block && "runs" in block ? block.runs.map((run) => run.text).join("") : undefined;

test("an alert keeps its kind and its text without the marker", () => {
  const [alert] = blocks("> [!WARNING]\n> Unsaved edits are lost.");
  expect(alert).toMatchObject({ k: "alert", kind: "warning" });
  expect(alert?.k === "alert" && text(alert.blocks[0])).toBe("Unsaved edits are lost.");
});

test("task boxes say whether they are ticked and where their mark is, so a tick rewrites only that box", () => {
  const source = "Before merging:\n\n- [ ] Rebase on main\n- [x] Fix the lint warning\n";
  const list = blocks(source).find((block) => block.k === "list");
  if (list?.k !== "list") throw new Error("no list");
  expect(list.items.map((item) => item.task?.checked)).toEqual([false, true]);
  const offset = list.items[0]?.task?.offset;
  if (offset === null || offset === undefined) throw new Error("unplaced box");
  expect(withTask(source, { offset, label: "Rebase on main" }, true)).toBe(
    "Before merging:\n\n- [x] Rebase on main\n- [x] Fix the lint warning\n",
  );
});

test("GitHub's HTML subset draws; anything else stays text", () => {
  const out = blocks(
    [
      "<details><summary>Lint output</summary>",
      "",
      "```",
      "warning",
      "```",
      "",
      "</details>",
      "",
      "Press <kbd>Tab</kbd>, H<sub>2</sub>O and x<sup>2</sup>.",
      "",
      '<script>alert("never runs")</script>',
    ].join("\n"),
  );
  expect(out[0]).toMatchObject({
    k: "details",
    summary: [{ text: "Lint output" }],
    blocks: [{ k: "code", text: "warning" }],
  });
  const line = out.find((block) => text(block)?.startsWith("Press"));
  expect(
    line?.k === "p" &&
      line.runs.filter((run) => run.kbd || run.sub || run.sup).map((run) => run.text),
  ).toEqual(["Tab", "2", "2"]);
  expect(out.some((block) => text(block)?.includes('<script>alert("never runs")</script>'))).toBe(
    true,
  );
});

test("pictures keep their light and dark images, and sized uploads keep their size", () => {
  const [picture, sized] = blocks(
    [
      "<picture>",
      '  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/dark.png">',
      '  <img alt="Logo" src="https://github.com/user-attachments/assets/light.png">',
      "</picture>",
      "",
      '<img width="320" alt="After" src="https://github.com/user-attachments/assets/after.png">',
    ].join("\n"),
  );
  expect(picture).toMatchObject({
    k: "image",
    src: "https://github.com/user-attachments/assets/light.png",
    dark: "https://github.com/user-attachments/assets/dark.png",
    alt: "Logo",
  });
  expect(sized).toMatchObject({ k: "image", width: 320, alt: "After" });
});

test("emoji, mentions, references and footnotes read as GitHub reads them", () => {
  const out = blocks(
    "Ships it :rocket: thanks @mira, fixes #238 [^docs]\n\n[^docs]: The old guide.",
  );
  const line = out[0];
  if (line?.k !== "p") throw new Error("no line");
  expect(text(line)).toBe("Ships it 🚀 thanks @mira, fixes #238 1");
  expect(line.runs.find((run) => run.text === "@mira")?.link).toBe("https://github.com/mira");
  expect(line.runs.find((run) => run.text === "#238")?.link).toBe(`${repo}/issues/238`);
  expect(line.runs.find((run) => run.text === "1")?.sup).toBe(true);
  expect(out.at(-1)).toMatchObject({
    k: "footnotes",
    notes: [{ number: 1, runs: [{ text: "The old guide." }] }],
  });
});

test("a mermaid fence is a diagram, and an upload link alone on its line may play", () => {
  const out = blocks(
    "```mermaid\nflowchart LR\n  A --> B\n```\n\nhttps://github.com/user-attachments/assets/0f3c2e9a-1b2c-4d5e-8f90-123456789abc\n",
  );
  expect(out[0]).toEqual({ k: "mermaid", text: "flowchart LR\n  A --> B" });
  expect(out[1]).toMatchObject({
    k: "media",
    url: "https://github.com/user-attachments/assets/0f3c2e9a-1b2c-4d5e-8f90-123456789abc",
  });
});
