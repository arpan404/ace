import { configure } from "@testing-library/react";
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
