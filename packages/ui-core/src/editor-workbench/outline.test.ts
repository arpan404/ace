import { describe, expect, test } from "vitest";
import {
  extractSymbols,
  filterSymbols,
  flattenSymbols,
  sortSymbols,
  symbolTrailAt,
  type OutlineSymbol,
} from "./outline.ts";

function summarize(symbols: readonly OutlineSymbol[]): unknown[] {
  return symbols.map((s) => ({
    name: s.name,
    kind: s.kind,
    line: s.line,
    endLine: s.endLine,
    ...(s.children.length > 0 ? { children: summarize(s.children) } : {}),
  }));
}

describe("extractSymbols", () => {
  test.each([
    {
      name: "TypeScript functions, classes with methods, interfaces, types, enums, and consts",
      language: "src/workspace-tabs.ts",
      text: [
        "// function commentedOut() {}",
        "/* class AlsoCommented { fake() {} } */",
        "export interface TabState {",
        "  active: string;",
        "}",
        "",
        "export type TabId = string;",
        "",
        "export const DEFAULT_LIMIT = 20;",
        "",
        "export const closeTab = (id: TabId) => {",
        '  const fake = "function notASymbol() {}";',
        "  return id;",
        "};",
        "",
        "export async function openTab(path: string) {",
        "  return path;",
        "}",
        "",
        "export class TabController {",
        "  constructor(private readonly max: number) {",
        "    this.max = max;",
        "  }",
        "",
        "  async #load(path: string) {",
        "    if (path) {",
        "      return path;",
        "    }",
        "    return '';",
        "  }",
        "",
        "  get count() {",
        "    return this.max;",
        "  }",
        "}",
      ].join("\n"),
      expected: [
        { name: "TabState", kind: "interface", line: 3, endLine: 5 },
        { name: "TabId", kind: "type", line: 7, endLine: 7 },
        { name: "DEFAULT_LIMIT", kind: "const", line: 9, endLine: 9 },
        { name: "closeTab", kind: "function", line: 11, endLine: 14 },
        { name: "openTab", kind: "function", line: 16, endLine: 18 },
        {
          name: "TabController",
          kind: "class",
          line: 20,
          endLine: 35,
          children: [
            { name: "constructor", kind: "method", line: 21, endLine: 23 },
            { name: "#load", kind: "method", line: 25, endLine: 30 },
            { name: "count", kind: "method", line: 32, endLine: 34 },
          ],
        },
      ],
    },
    {
      name: "Rust structs, enums, traits, impl methods, functions, mods, and consts",
      language: "crates/editor/src/lib.rs",
      text: [
        "/* nested /* fn ignored() {} */ comment */",
        "pub const MAX_LINES: usize = 500;",
        "",
        "#[derive(Debug)]",
        "pub struct Buffer {",
        "    text: String,",
        "}",
        "",
        "pub enum EditKind {",
        "    Insert,",
        "    Delete,",
        "}",
        "",
        "pub trait Searchable {",
        "    fn find(&self, needle: &str) -> Option<usize>;",
        "}",
        "",
        "impl Buffer {",
        "    pub fn new(text: String) -> Self {",
        '        let raw = r#"fn not_a_fn() {}"#;',
        "        Self { text }",
        "    }",
        "",
        "    pub async fn reload(&mut self) {",
        "        self.text.clear();",
        "    }",
        "}",
        "",
        "pub mod helpers {",
        "    pub fn clamp(v: usize) -> usize {",
        "        v",
        "    }",
        "}",
      ].join("\n"),
      expected: [
        { name: "MAX_LINES", kind: "const", line: 2, endLine: 2 },
        { name: "Buffer", kind: "struct", line: 5, endLine: 7 },
        { name: "EditKind", kind: "enum", line: 9, endLine: 12 },
        {
          name: "Searchable",
          kind: "interface",
          line: 14,
          endLine: 16,
          children: [{ name: "find", kind: "method", line: 15, endLine: 15 }],
        },
        {
          name: "impl Buffer",
          kind: "class",
          line: 18,
          endLine: 27,
          children: [
            { name: "new", kind: "method", line: 19, endLine: 22 },
            { name: "reload", kind: "method", line: 24, endLine: 26 },
          ],
        },
        {
          name: "helpers",
          kind: "module",
          line: 29,
          endLine: 33,
          children: [{ name: "clamp", kind: "function", line: 30, endLine: 32 }],
        },
      ],
    },
    {
      name: "Python classes, methods, async functions, constants, and docstrings",
      language: "scripts/index.py",
      text: [
        "MAX_RETRIES = 3",
        "",
        "class Indexer:",
        '    """',
        "    def fake_in_docstring():",
        "        pass",
        '    """',
        "    def __init__(self, root: str):",
        "        self.root = root",
        "",
        "    async def scan(self):",
        "        return []",
        "",
        "# def commented(): pass",
        "def run_all(root: str):",
        "    def inner():",
        "        return root",
        "    return inner()",
      ].join("\n"),
      expected: [
        { name: "MAX_RETRIES", kind: "const", line: 1, endLine: 1 },
        {
          name: "Indexer",
          kind: "class",
          line: 3,
          endLine: 12,
          children: [
            { name: "__init__", kind: "method", line: 8, endLine: 9 },
            { name: "scan", kind: "method", line: 11, endLine: 12 },
          ],
        },
        {
          name: "run_all",
          kind: "function",
          line: 15,
          endLine: 18,
          children: [{ name: "inner", kind: "function", line: 16, endLine: 17 }],
        },
      ],
    },
    {
      name: "Markdown headings nested by level while ignoring fenced code blocks",
      language: "docs/guide.md",
      text: [
        "# Editor guide",
        "Intro paragraph.",
        "",
        "## Architecture",
        "```bash",
        "# Not a heading inside code fence",
        "echo hi",
        "```",
        "",
        "### Buffers",
        "Details about buffers.",
        "",
        "## Shortcuts ##",
        "Shortcut list.",
      ].join("\n"),
      expected: [
        {
          name: "Editor guide",
          kind: "heading",
          line: 1,
          endLine: 14,
          children: [
            {
              name: "Architecture",
              kind: "heading",
              line: 4,
              endLine: 12,
              children: [{ name: "Buffers", kind: "heading", line: 10, endLine: 12 }],
            },
            { name: "Shortcuts", kind: "heading", line: 13, endLine: 14 },
          ],
        },
      ],
    },
  ])("$name", ({ language, text, expected }) => {
    expect(summarize(extractSymbols(text, language))).toEqual(expected);
  });

  test("returns empty for empty text or unsupported file types", () => {
    expect(extractSymbols("", "ts")).toEqual([]);
    expect(extractSymbols("hello world", "notes.txt")).toEqual([]);
    expect(extractSymbols("hello world", undefined)).toEqual([]);
  });
});

describe("symbolTrailAt", () => {
  const sample = extractSymbols(
    [
      "export const HEADER = 1;",
      "",
      "export class Editor {",
      "  open(path: string) {",
      "    return path;",
      "  }",
      "",
      "  close() {",
      "    return true;",
      "  }",
      "}",
      "",
      "export function standalone() {",
      "  return 42;",
      "}",
    ].join("\n"),
    "editor.ts",
  );

  test.each([
    { line: 1, names: ["HEADER"] },
    { line: 2, names: [] },
    { line: 3, names: ["Editor"] },
    { line: 5, names: ["Editor", "open"] },
    { line: 7, names: ["Editor"] },
    { line: 9, names: ["Editor", "close"] },
    { line: 11, names: ["Editor"] },
    { line: 14, names: ["standalone"] },
    { line: 99, names: [] },
  ])("line $line resolves trail $names", ({ line, names }) => {
    expect(symbolTrailAt(sample, line).map((s) => s.name)).toEqual(names);
  });
});

describe("sortSymbols, filterSymbols, and flattenSymbols", () => {
  const tree = extractSymbols(
    [
      "export class Zebra {",
      "  zeta() { return 1; }",
      "  alpha() { return 2; }",
      "}",
      "export function beta() { return 3; }",
      "export const apple = 4;",
    ].join("\n"),
    "sample.ts",
  );

  test("sorts recursively by name or position", () => {
    const byName = sortSymbols(tree, "name");
    expect(byName.map((s) => s.name)).toEqual(["apple", "beta", "Zebra"]);
    expect(byName[2]?.children.map((c) => c.name)).toEqual(["alpha", "zeta"]);

    const byPosition = sortSymbols(byName, "position");
    expect(byPosition.map((s) => s.name)).toEqual(["Zebra", "beta", "apple"]);
    expect(byPosition[0]?.children.map((c) => c.name)).toEqual(["zeta", "alpha"]);
  });

  test("filters keeping ancestor containers when a child matches", () => {
    const filtered = filterSymbols(tree, "alp");
    expect(filtered.map((s) => s.name)).toEqual(["Zebra"]);
    expect(filtered[0]?.children.map((c) => c.name)).toEqual(["alpha"]);
  });

  test("flattens tree with depth and enclosing container", () => {
    expect(
      flattenSymbols(tree).map((entry) => ({
        name: entry.symbol.name,
        depth: entry.depth,
        container: entry.container,
      })),
    ).toEqual([
      { name: "Zebra", depth: 0, container: undefined },
      { name: "zeta", depth: 1, container: "Zebra" },
      { name: "alpha", depth: 1, container: "Zebra" },
      { name: "beta", depth: 0, container: undefined },
      { name: "apple", depth: 0, container: undefined },
    ]);
  });
});

describe("symbolTrailAt in a large file", () => {
  test("finding the caret's symbol among 100,000 reads a handful of positions, not all", () => {
    let reads = 0;
    const symbols: OutlineSymbol[] = Array.from({ length: 100_000 }, (_, index) => {
      const start = index * 3 + 1;
      return {
        name: `f${index}`,
        kind: "function",
        get line() {
          reads++;
          return start;
        },
        column: 1,
        endLine: start + 1,
        children: [],
      };
    });
    const trail = symbolTrailAt(symbols, 3 * 70_000 + 2);
    expect(trail.map((symbol) => symbol.name)).toEqual(["f70000"]);
    expect(reads).toBeLessThan(64);
    // Between two symbols (the blank line after one) there is no trail.
    expect(symbolTrailAt(symbols, 3 * 70_000 + 3)).toEqual([]);
    expect(symbolTrailAt(symbols, 1).map((symbol) => symbol.name)).toEqual(["f0"]);
  });
});
