import { Item, type ToolCall } from "@ace/protocol";
import { expect, test } from "vitest";
import { describeStep, stepFact, stepLabels, summarizeWork, workCounts } from "./index.ts";

let ids = 0;
function step(
  detail: ToolCall["detail"],
  options: { title?: string; status?: ToolCall["status"] | undefined } = {},
) {
  const id = `item-${++ids}`;
  const status = options.status ?? "succeeded";
  return Item.parse({
    id,
    agentId: "root",
    createdAt: ids,
    complete: status !== "running",
    type: "tool_call",
    call: {
      id,
      agentId: "root",
      kind: "search",
      title: options.title ?? "ToolSearch",
      status,
      detail,
      startedAt: ids,
      endedAt: ids,
      raw: [],
    },
  });
}

const toolSearch = (query: string, status?: ToolCall["status"]) =>
  step({ kind: "search", query, scope: "tools" }, { status });
const row = (item: Item) => {
  const shown = describeStep(item, { labels: stepLabels });
  return { verb: shown.verb, target: shown.target, mark: shown.ace?.mark };
};

test("loading one of ace's tools reads as what the tool does, with ace's mark, never the raw query", () => {
  expect(row(toolSearch("select:mcp__ace__thread_link_pr"))).toEqual({
    verb: "Loaded the ace tool to link a PR",
    target: undefined,
    mark: { kind: "glyph", glyph: "ace" },
  });
  expect(row(toolSearch("select:mcp__ace__thread_link_pr", "running")).verb).toBe(
    "Loading the ace tool to link a PR",
  );
  expect(row(toolSearch("select:mcp__ace__thread_read,mcp__ace__notify")).verb).toBe(
    "Loaded ace tools to read this thread and notify you",
  );
  expect(
    row(toolSearch("select:mcp__ace__thread_read,mcp__ace__notify,mcp__ace__delegate")).verb,
  ).toBe("Loaded 3 ace tools");
});

test("loading other tools names them, an MCP tool by its server", () => {
  expect(row(toolSearch("select:Read,mcp__Neon__run_sql"))).toEqual({
    verb: "Loaded 2 tools",
    target: "Read, Neon › run_sql",
    mark: undefined,
  });
  expect(row(toolSearch("select:WebFetch"))).toMatchObject({
    verb: "Loaded the tool",
    target: "WebFetch",
  });
});

test("a keyword search of the tools reads as one, without its required-term marker", () => {
  expect(row(toolSearch("+slack send"))).toMatchObject({
    verb: "Searched tools for",
    target: "slack send",
  });
});

test("a tool search recorded before the scope was marked still reads as one", () => {
  const older = step({ kind: "search", query: "select:mcp__ace__thread_link_pr" });
  expect(row(older).verb).toBe("Loaded the ace tool to link a PR");
});

test("a code search that happens to look like a tool query stays a search", () => {
  const grep = step({ kind: "search", query: "select:" }, { title: "Grep" });
  expect(row(grep)).toMatchObject({ verb: "Searched", target: "select:" });
});

test("loading tools is not counted as a search of the code", () => {
  const items = [toolSearch("select:mcp__ace__thread_link_pr")];
  expect(workCounts(summarizeWork(items))).toBe("Used 1 tool");
  expect(stepFact(items[0]!)?.kind).toBe("tool");
});
