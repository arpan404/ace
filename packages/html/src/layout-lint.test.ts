import { expect, test } from "vitest";
import { checkHtmlForPublish, estimateHtmlLayout, lintHtmlLayout } from "./index.ts";

const page = (head: string, body = "<p>Hi</p>") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const codes = (html: string) => lintHtmlLayout(html).map((entry) => entry.code);
const guesses = (html: string) => estimateHtmlLayout(html).map((entry) => entry.code);

test.each([
  ["viewport units on an app mockup", page("<style>.app{height:100vh}</style>"), "viewport-height"],
  ["dynamic viewport units", page("<style>.app{min-height:100dvh}</style>"), "viewport-height"],
  ["a full-height body", page("<style>html,body{height:100%}</style>"), "root-height"],
  ["a fixed overlay", page("<style>.sheet{position:fixed;inset:0}</style>"), "fixed-position"],
])("publishing refuses %s at any width", (_name, html, code) => {
  expect(codes(html)).toContain(code);
  expect(checkHtmlForPublish(html).valid).toBe(false);
});

test.each([
  ["a card wider than a phone", page("<style>.card{width:480px}</style>"), "fixed-width"],
  ["an inline wide width", page("", '<div style="width:900px">wide</div>'), "fixed-width"],
  ["tiny labels", page("<style>.meta{font-size:8px}</style>"), "text-too-small"],
  [
    "a wide SVG diagram with small labels",
    page("", '<svg viewBox="0 0 900 400"><text x="10" y="20" font-size="11">Checks</text></svg>'),
    "svg-text-too-small",
  ],
])("without a layout engine, the markup guess refuses %s", (_name, html, code) => {
  expect(guesses(html)).toContain(code);
});

test("width and text size are left to the phone layout when one can run", () => {
  const html = page("<style>.card{width:480px}.meta{font-size:8px}</style>");
  expect(checkHtmlForPublish(html)).toMatchObject({ valid: true, diagnostics: [] });
});

test.each([
  [
    "a page built from the kit",
    page("", '<div class="ace-grid"><div class="ace-stat">1</div></div>'),
  ],
  ["a capped width", page("<style>.card{width:min(100%,480px);max-width:640px}</style>")],
  [
    "a width only on wide screens",
    page("<style>@media (min-width:700px){.side{width:420px}}</style>"),
  ],
  [
    "deliberately wide content in a scroller",
    page(
      "",
      '<div class="ace-scroll-x"><table style="width:900px"><tr><td>a</td></tr></table></div>',
    ),
  ],
  [
    "a narrow SVG with readable labels",
    page("", '<svg viewBox="0 0 480 200"><text font-size="14">Start</text></svg>'),
  ],
  [
    "a wide SVG with no text",
    page("", '<svg viewBox="0 0 1200 300"><rect width="1200" height="300"/></svg>'),
  ],
  [
    "a wide SVG in a scroller",
    page(
      "",
      '<div class="ace-scroll-x"><svg viewBox="0 0 1200 300"><text font-size="12">Lane</text></svg></div>',
    ),
  ],
  [
    "deliberately wide content in a box of the page's own that scrolls sideways",
    page(
      "",
      '<div style="overflow-x:auto"><table style="width:900px"><tr><td>a</td></tr></table></div>',
    ),
  ],
  [
    "fixed pixel heights for a mockup frame",
    page("<style>.ace-frame{--h:560px}.panel{height:420px}</style>"),
  ],
])("publishing accepts %s", (_name, html) => {
  expect([...codes(html), ...guesses(html)]).toEqual([]);
  expect(checkHtmlForPublish(html)).toMatchObject({ valid: true, diagnostics: [] });
});

test("safety and layout problems come back together in one call", () => {
  const result = checkHtmlForPublish(
    page("<style>.app{height:100vh}</style>", '<a href="https://example.invalid">Leave</a>'),
  );
  expect(result.diagnostics.map((entry) => entry.code)).toEqual([
    "external-resource",
    "viewport-height",
  ]);
});
