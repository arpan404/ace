import { configure, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import type { RowMark } from "./file-tree-row.tsx";
import { renderTree, row } from "./tree-test-support.tsx";

configure({ asyncUtilTimeout: 10000 });

test("a row an agent changed recently carries the agent's mark and says who and when", async () => {
  const marks = new Map<string, RowMark>([
    ["README.md", { name: "Claude Code", provider: "claude", age: "4m" }],
  ]);
  const { tree } = await renderTree({ marks });
  const readme = await row(tree, "README.md");
  expect(readme.getAttribute("aria-description")).toBe("Changed by Claude Code · 4m");
  expect(readme.querySelector("[data-agent-mark]")).toBeTruthy();
  // Other rows carry nothing.
  const other = await row(tree, "package.json");
  expect(other.getAttribute("aria-description")).toBeNull();
  expect(other.querySelector("[data-agent-mark]")).toBeNull();
});

test("a file changed since the last commit shows its added and removed lines; folders don't", async () => {
  const gitDiff = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,2 +1,3 @@",
    "-# Relay",
    "+# Relay service",
    "+",
    " Notes",
    "diff --git a/apps/server/src/cursor.ts b/apps/server/src/cursor.ts",
    "--- a/apps/server/src/cursor.ts",
    "+++ b/apps/server/src/cursor.ts",
    "@@ -1 +1 @@",
    "-export const a = 1;",
    "+export const a = 2;",
    "",
  ].join("\n");
  const { tree } = await renderTree({ gitDiff });
  const readme = await row(tree, "README.md");
  await waitFor(() =>
    expect(readme.querySelector("[data-part='line-counts']")?.textContent).toMatch(/^\+2 −1/),
  );
  expect(readme.getAttribute("aria-description")).toBe("2 added, 1 removed since the last commit");
  // Unchanged files and folders, even one holding a change, carry no counts.
  expect((await row(tree, "package.json")).querySelector("[data-part='line-counts']")).toBeNull();
  expect((await row(tree, "apps/")).querySelector("[data-part='line-counts']")).toBeNull();
});
