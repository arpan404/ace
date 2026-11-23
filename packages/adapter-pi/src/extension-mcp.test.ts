import { expect, test } from "vitest";
import { readOnlyAceTool, type AceToolFilter } from "./extension-mcp.ts";

type Listed = Parameters<AceToolFilter>[0];
const tool = (name: string, readOnlyHint: boolean): Listed => ({
  name,
  inputSchema: { type: "object" },
  annotations: { readOnlyHint },
});

test("read-only Pi keeps ace's reads, never a write", () => {
  const kept = [
    tool("context", true),
    tool("guide", true),
    tool("delegate", false),
    tool("notify", false),
  ].filter(readOnlyAceTool);
  expect(kept.map((each) => each.name)).toEqual(["context", "guide"]);
});
