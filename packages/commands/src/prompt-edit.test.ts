import { expect, test } from "vitest";
import { promptFields, updatePrompt, parseMarkdown } from "./parse-markdown.ts";

test("editing the prompt body preserves unknown metadata and comments used by the slash command", () => {
  const source =
    "---\n# Keep this note\nname: review\ndescription: Check changes\nprovider: codex\ncustom: retained\n---\nOld instructions\n";
  const edited = updatePrompt(source, {
    body: "First line\nSecond line\n",
    description: "Review carefully",
  });
  expect(edited).toContain("# Keep this note");
  expect(edited).toContain("custom: retained");
  expect(promptFields(edited)).toMatchObject({
    name: "review",
    description: "Review carefully",
    provider: "codex",
    body: "First line\nSecond line\n",
  });
  const parsed = parseMarkdown(edited, {
    source: "review.md",
    name: "review",
    scope: "user",
    format: "library",
  });
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.commands[0]?.body).toBe("First line\nSecond line\n");
});

test("a plain prompt stays plain and malformed frontmatter remains available for source repair", () => {
  expect(updatePrompt("Plain instructions", { body: "Revised instructions" })).toBe(
    "Revised instructions",
  );
  expect(promptFields("---\nname: [\n---\nRepair this")).toBeUndefined();
});

test("clearing a prompt name restores the filename-based slash command without losing its instructions", () => {
  const edited = updatePrompt("---\nname: previous\ndescription: Check it\n---\nRead the diff", {
    name: "",
  });
  const parsed = parseMarkdown(edited, {
    source: "review.md",
    name: "review",
    scope: "user",
    format: "library",
  });
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.commands[0]?.name).toBe("review");
  expect(parsed.commands[0]?.body).toBe("Read the diff");
});
