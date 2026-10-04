import { expect, test } from "vitest";
import { urlSuggestions } from "./suggestions.ts";

const page = (url: string, closed = false) => ({
  threadId: "t",
  controller: "agent" as const,
  url,
  closed,
});

test("the browser's page comes first, then each dev server once", () => {
  const suggestions = urlSuggestions(page("localhost:5173/settings"), [
    { port: 5173, origin: "http://localhost:5173", name: "web", source: "terminal" },
    { port: 8787, source: "listener" },
    { port: 5173, origin: "http://localhost:5173/", source: "listener" },
  ]);
  expect(suggestions.map((each) => [each.label, each.url])).toEqual([
    ["localhost:5173/settings", "http://localhost:5173/settings"],
    ["web", "http://localhost:5173"],
    ["localhost:8787", "http://localhost:8787"],
  ]);
});

test("a closed or blank browser suggests nothing of its own", () => {
  expect(urlSuggestions(page("http://localhost:3000", true), [])).toEqual([]);
  expect(urlSuggestions(page("about:blank"), [])).toEqual([]);
});

test("suggestions stop at the limit", () => {
  const servers = [3000, 3001, 3002, 3003, 3004].map((port) => ({
    port,
    source: "listener" as const,
  }));
  expect(urlSuggestions(undefined, servers, 4)).toHaveLength(4);
});
