import { expect, test } from "vitest";
import { htmlPieces } from "./html-pieces.ts";
import { htmlTree, type HtmlNode } from "./html-tree.ts";

/** The tree raw HTML in forge text draws, as one run. */
const tree = (html: string) => htmlTree([{ kind: "html", pieces: htmlPieces(html) }], "github.com");

/** Every element drawn, with its kept attributes, depth first. */
function elements(nodes: readonly HtmlNode[]): { tag: string; attrs: Record<string, string> }[] {
  return nodes.flatMap((node) =>
    node.kind === "element"
      ? [{ tag: node.tag, attrs: { ...node.attrs } }, ...elements(node.children)]
      : [],
  );
}
const text = (nodes: readonly HtmlNode[]): string =>
  nodes
    .map((node) =>
      node.kind === "text" ? node.text : node.kind === "element" ? text(node.children) : "",
    )
    .join("");

const live = /^(https?:|mailto:|#)/;

test.each([
  ["a tab inside the scheme", '<a href="jav&#x09;ascript:alert(1)">x</a>'],
  ["a leading space", '<a href=" javascript:alert(1)">x</a>'],
  ["upper case and entities", '<a href="JaVaScRiPt&colon;alert(1)">x</a>'],
  ["a data URL", '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
  ["a vbscript URL", '<a href="vbscript:msgbox(1)">x</a>'],
  ["a protocol-relative link", '<a href="//evil.example/x">x</a>'],
])("a link with %s is never live", (_case, html) => {
  expect(elements(tree(html)).some((element) => element.attrs.href !== undefined)).toBe(false);
});

test.each([
  ["onerror", '<img src="https://ok.example/a.png" onerror="alert(1)">'],
  ["a quote-joined onerror", '<img src="https://ok.example/a.png"onerror=alert(1)>'],
  ["backtick quoting", "<img src=`x` onerror=alert(1)>"],
  [
    "a srcset with javascript:",
    '<picture><source srcset="javascript:alert(1)"><img src="https://ok.example/a.png"></picture>',
  ],
  [
    "a srcset with data:",
    '<picture><source srcset="data:image/svg+xml,<svg onload=alert(1)>"></picture>',
  ],
  [
    "target, style, class and handlers",
    '<a href="https://ok.example" target="_top" style="x" class="y" onclick="z">x</a>',
  ],
])("an element with %s keeps no handler, style, target or unsafe URL", (_case, html) => {
  for (const element of elements(tree(html))) {
    expect(Object.keys(element.attrs).filter((name) => name.startsWith("on"))).toEqual([]);
    expect(element.attrs).not.toHaveProperty("style");
    expect(element.attrs).not.toHaveProperty("class");
    expect(element.attrs).not.toHaveProperty("target");
    for (const name of ["href", "src", "srcset"])
      if (element.attrs[name] !== undefined) expect(element.attrs[name]).toMatch(live);
  }
});

test.each([
  ["an inline SVG with a script", "<svg><script>alert(1)</script></svg>", "<svg>"],
  ["MathML", "<math><mi>x</mi></math>", "<math>"],
  ["a script", "<script>alert(1)</script>", "<script>"],
  ["an iframe", '<iframe src="https://evil.example"></iframe>', "<iframe"],
  ["a form", '<form action="https://evil.example"><input name="q"></form>', "<form"],
  ["a style sheet", "<style>body{display:none}</style>", "<style>"],
])("%s is shown as text, never as an element", (_case, html, shown) => {
  const nodes = tree(html);
  expect(elements(nodes).map((element) => element.tag)).toEqual([]);
  expect(text(nodes)).toContain(shown);
});

test("the first of repeated attributes wins, as in a browser", () => {
  const [link] = elements(tree('<a href="https://ok.example" href="javascript:alert(1)">x</a>'));
  expect(link?.attrs.href).toBe("https://ok.example/");
});

test("an unclosed tag wraps only what follows it and closes at the end of the run", () => {
  const nodes = tree('before <b>bold <a href="https://ok.example">link');
  expect(elements(nodes).map((element) => element.tag)).toEqual(["b", "a"]);
  expect(text(nodes)).toBe("before bold link");
});
