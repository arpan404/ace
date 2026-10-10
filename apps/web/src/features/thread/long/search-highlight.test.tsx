import { useTranscriptHighlight } from "./search-highlight.ts";
import { render, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

function MarkedText({ text, query }: { text: string; query: string }) {
  useTranscriptHighlight(query);
  return (
    <div role="feed">
      <article data-hit="">{text}</article>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("search highlights keep their original offsets after length-changing Unicode case maps", () => {
  const highlights = new Map<string, Range[]>();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal("Highlight", class extends Array<Range> {});
  render(<MarkedText text="İ before MATCH and match" query="match" />);
  expect(highlights.get("ace-find")?.map((range) => range.toString())).toEqual(["MATCH", "match"]);
});

test("search treats regular expression characters as literal text", () => {
  const highlights = new Map<string, Range[]>();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal("Highlight", class extends Array<Range> {});
  render(<MarkedText text="Try [a+b] then aab" query="[a+b]" />);
  expect(highlights.get("ace-find")?.map((range) => range.toString())).toEqual(["[a+b]"]);
});
