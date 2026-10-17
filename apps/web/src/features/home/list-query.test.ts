import { expect, test } from "vitest";
import { filterByQuery } from "./list-query.ts";

const names: Record<string, string> = { w1: "payments-api", w2: "web" };
const projectName = (id: string) => names[id] ?? "Project";
const entries = [
  { id: "a", title: "Partial refunds", workspaceId: "w1", details: { branch: "fix/refunds" } },
  { id: "b", title: "Dedupe thread events", workspaceId: "w2", details: { branch: null } },
  { id: "c", title: "Bump Codex", workspaceId: "w2", details: undefined },
];
const ids = (query: string) => filterByQuery(entries, query, projectName).map((entry) => entry.id);

test("search matches a thread's title, whatever the case", () => {
  expect(ids("DEDUPE")).toEqual(["b"]);
});

test("search matches the thread's project name", () => {
  expect(ids("payments")).toEqual(["a"]);
  expect(ids("web")).toEqual(["b", "c"]);
});

test("search matches the thread's branch", () => {
  expect(ids("fix/")).toEqual(["a"]);
});

test("blank words leave the whole list", () => {
  expect(ids("   ")).toEqual(["a", "b", "c"]);
});

test("words found nowhere leave nothing", () => {
  expect(ids("nothing like this")).toEqual([]);
});
