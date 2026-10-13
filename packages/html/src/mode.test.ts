import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { expect, test } from "vitest";
import { resolveHtmlMode, staticHtmlCsp, visualizationDocument } from "./index.ts";

const withBody = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

test("an omitted mode is static without a script and interactive with one", () => {
  expect(resolveHtmlMode(withBody("<svg><rect width='4' height='4'/></svg>"), undefined)).toBe(
    "static",
  );
  expect(resolveHtmlMode(withBody("<script>draw()</script>"), undefined)).toBe("interactive");
  expect(resolveHtmlMode(withBody("<svg><script>draw()</script></svg>"), undefined)).toBe(
    "interactive",
  );
  expect(resolveHtmlMode(withBody('<button onclick="go()">Go</button>'), undefined)).toBe(
    "interactive",
  );
  expect(resolveHtmlMode(withBody("<template><script>go()</script></template>"), undefined)).toBe(
    "interactive",
  );
  // The agent's explicit choice wins either way.
  expect(resolveHtmlMode(withBody("<script>draw()</script>"), "static")).toBe("static");
  expect(resolveHtmlMode(withBody("<p>Read only</p>"), "interactive")).toBe("interactive");
});

/** The page the outer document frames, as the browser receives it. */
function framedPage(outer: string): string {
  const match = /srcdoc="([^"]*)"/.exec(outer);
  if (!match?.[1]) throw new Error("Missing page");
  return match[1]
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

function scripts(page: string): string[] {
  const found: string[] = [];
  const visit = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node && node.tagName === "script")
      found.push(node.childNodes.map((child) => ("value" in child ? child.value : "")).join(""));
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  parse(page).childNodes.forEach(visit);
  return found;
}

test("a static page keeps only the bridge, and its policy admits nothing else", () => {
  const html =
    '<!doctype html><html><body><button onclick="go()">Go</button><script>go()</script><svg><script>go()</script></svg></body></html>';
  const page = framedPage(visualizationDocument(html, {}, "static"));
  const remaining = scripts(page);
  expect(page).not.toContain("onclick");
  expect(remaining).toHaveLength(1);
  const hash = createHash("sha256")
    .update(remaining[0] ?? "")
    .digest("base64");
  expect(staticHtmlCsp).toContain(`script-src 'sha256-${hash}'`);
  expect(staticHtmlCsp).not.toMatch(/script-src[^;]*unsafe/);
  expect(page).toContain(`script-src 'sha256-${hash}'`);

  const interactive = framedPage(visualizationDocument(html, {}, "interactive"));
  expect(scripts(interactive)).toHaveLength(3);
  expect(interactive).toContain("onclick");
});
