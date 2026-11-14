import { describe, expect, it } from "vitest";
import { suitLimits } from "../limits.ts";
import { sanitiseSuitCss } from "./sanitise.ts";

const run = (text: string, assets: string[] = ["assets/bg.png", "assets/face.woff2"]) =>
  sanitiseSuitCss({
    id: "neon",
    text,
    assets: new Set(assets),
    url: (path) => `/v1/suits/neon/h/g/${path}`,
  });

describe("suit.css rules a Suit may write", () => {
  const allowed: [string, string, string][] = [
    [
      "a part's background",
      `[data-part="sidebar"] { background: linear-gradient(red, blue) }`,
      `[data-suit="neon"] [data-part="sidebar"]{background:linear-gradient(red,blue)}`,
    ],
    [
      "a part in a state, with a pseudo-class and ::before",
      `[data-part=thread-row][data-state=selected]:hover::before { content: "★"; color: #f0f }`,
      `[data-suit="neon"] [data-part=thread-row][data-state=selected]:hover::before{content:"★";color:#f0f}`,
    ],
    [
      "a scheme joins the Suit's own scope",
      `[data-scheme=dark] [data-part=header] { border-color: #333 }`,
      `[data-suit="neon"][data-scheme=dark] [data-part=header]{border-color:#333}`,
    ],
    [
      "a bundled image, rewritten to its served URL",
      `[data-part=rail] { background-image: url(./assets/bg.png) }`,
      `[data-suit="neon"] [data-part=rail]{background-image:url(/v1/suits/neon/h/g/assets/bg.png)}`,
    ],
    [
      "a region background through its custom property",
      `[data-part=app] { --suit-sidebar-background: url("assets/bg.png") repeat }`,
      `[data-suit="neon"] [data-part=app]{--suit-sidebar-background:url(/v1/suits/neon/h/g/assets/bg.png)repeat}`,
    ],
    [
      "framing an agent-state part",
      `[data-part=approval-strip] { border-radius: 0; padding: 4px 8px; font-family: serif }`,
      `[data-suit="neon"] [data-part=approval-strip]{border-radius:0;padding:4px 8px;font-family:serif}`,
    ],
    [
      ":is() of parts and :has() of a child part",
      `:is([data-part=menu], [data-part=popover]):has(> [data-part=menu-item]) { backdrop-filter: blur(8px) }`,
      `[data-suit="neon"] :is([data-part=menu],[data-part=popover]):has(>[data-part=menu-item]){backdrop-filter:blur(8px)}`,
    ],
    [
      "a scrollbar pseudo-element",
      `[data-part=transcript]::-webkit-scrollbar-thumb { background: #f0f }`,
      `[data-suit="neon"] [data-part=transcript]::-webkit-scrollbar-thumb{background:#f0f}`,
    ],
    [
      "preference and width queries",
      `@media (prefers-color-scheme: dark) and (min-width: 600px) { [data-part=composer] { box-shadow: 0 0 8px #f0f } }`,
      `@media (prefers-color-scheme:dark) and (min-width:600px){[data-suit="neon"] [data-part=composer]{box-shadow:0 0 8px #f0f}}`,
    ],
    [
      "a bundled font face",
      `@font-face { font-family: Neon; src: url(assets/face.woff2) format("woff2") }`,
      `@font-face{font-family:Neon;src:url(/v1/suits/neon/h/g/assets/face.woff2)format("woff2")}`,
    ],
    [
      "a small raster data: image",
      `[data-part=badge] { background: url(data:image/png;base64,iVBORw0KGgo=) }`,
      `[data-suit="neon"] [data-part=badge]{background:url(data:image/png;base64,iVBORw0KGgo=)}`,
    ],
  ];
  it.each(allowed)("keeps %s, scoped to the Suit", (_name, input, output) => {
    const result = run(input);
    expect(result.problems).toEqual([]);
    expect(result.css).toBe(output);
  });

  it("renames keyframes with the Suit's id and runs animations only while motion is allowed", () => {
    const result = run(
      `[data-part=sidebar] { animation: glow 2s infinite alternate; color: red }\n@keyframes glow { from { opacity: .6 } to { opacity: 1 } }`,
    );
    expect(result.problems).toEqual([]);
    expect(result.css).toBe(
      [
        `[data-suit="neon"] [data-part=sidebar]{color:red}`,
        `[data-suit="neon"]:not([data-reduce-motion]) [data-part=sidebar]{animation:suit-neon-glow 2s infinite alternate}`,
        `@keyframes suit-neon-glow{from{opacity:.6}to{opacity:1}}`,
      ].join("\n"),
    );
  });
});

describe("suit.css rules a Suit may not write", () => {
  const refused: [string, string, number, RegExp][] = [
    ["@import", `@import "other.css";`, 1, /@import/],
    ["a class", `\n.sidebar { color: red }`, 2, /class/],
    ["an id", `#main { color: red }`, 1, /id/],
    ["an element", `[data-part=sidebar] div { color: red }`, 1, /element/],
    ["the universal selector", `[data-part=sidebar] > * { color: red }`, 1, /universal/],
    ["an unknown part", `[data-part=sidebarz] { color: red }`, 1, /not a published part/],
    [
      "a selector that ends off a part",
      `[data-part=sidebar] [data-state=open] { color: red }`,
      1,
      /end on a \[data-part\]/,
    ],
    ["another attribute", `[data-part=sidebar][aria-hidden] { color: red }`, 1, /aria-hidden/],
    ["a class under :not()", `[data-part=thread-row]:not(.x) { color: red }`, 1, /class/],
    [
      "a remote url",
      `[data-part=rail] {\n  background: url(https://example.com/a.png)\n}`,
      2,
      /outside the Suit/,
    ],
    [
      "a missing asset",
      `[data-part=rail] { background: url(assets/missing.png) }`,
      1,
      /not in the Suit/,
    ],
    [
      "a path out of assets",
      `[data-part=rail] { background: url(assets/../suit.json) }`,
      1,
      /outside the Suit/,
    ],
    [
      "an SVG data: url",
      `[data-part=rail] { background: url("data:image/svg+xml,<svg/>") }`,
      1,
      /data: images/,
    ],
    [
      "an escaped url()",
      `[data-part=rail] { background: \\75 rl("https://x/a.png") }`,
      1,
      /escapes/,
    ],
    [
      "a string image-set()",
      `[data-part=rail] { background: image-set("https://x/a.png" 1x) }`,
      1,
      /strings/,
    ],
    ["expression()", `[data-part=rail] { width: expression(alert(1)) }`, 1, /expression\(\)/],
    ["attr()", `[data-part=rail]::after { content: attr(data-secret) }`, 1, /attr\(\)/],
    ["behavior", `[data-part=rail] { behavior: url(x.htc) }`, 1, /behavior/],
    ["-moz-binding", `[data-part=rail] { -moz-binding: url(x.xml) }`, 1, /-moz-binding/],
    ["!important", `[data-part=rail] { color: red !important }`, 1, /!important/],
    ["ace's own tokens", `[data-part=app] { --status-working: pink }`, 1, /--suit-/],
    [
      "hiding the approval strip",
      `[data-part=approval-strip] { display: none }`,
      1,
      /agent-state part/,
    ],
    [
      "recolouring a status icon",
      `[data-part=thread-row] [data-part=status-icon] { color: pink }`,
      1,
      /agent-state part/,
    ],
    [
      "animating the Working line",
      `[data-part=working-line] { animation: x 1s }`,
      1,
      /agent-state part/,
    ],
    ["a device query", `@media (hover: hover) { [data-part=rail] { color: red } }`, 1, /hover/],
    ["print media", `@media print { [data-part=rail] { color: red } }`, 1, /print/],
    ["@supports", `@supports (display: grid) { [data-part=rail] { color: red } }`, 1, /@supports/],
    [
      "a font face from a remote host",
      `@font-face { font-family: X; src: url(https://fonts.example/x.woff2) }`,
      1,
      /assets\//,
    ],
  ];
  it.each(refused)("refuses %s, with its line", (_name, input, line, message) => {
    const result = run(input);
    expect(result.problems).toEqual([
      expect.objectContaining({
        check: "css",
        field: "suit.css",
        line,
        message: expect.stringMatching(message),
      }),
    ]);
  });

  it("drops a refused rule but keeps the ones around it", () => {
    const result = run(
      `[data-part=rail] { color: red }\n.x { color: blue }\n[data-part=header] { color: green }`,
    );
    expect(result.css).toBe(
      `[data-suit="neon"] [data-part=rail]{color:red}\n[data-suit="neon"] [data-part=header]{color:green}`,
    );
    expect(result.problems.map((problem) => problem.line)).toEqual([2]);
  });

  it("keeps a rule's allowed declarations and refuses only the bad one", () => {
    const result = run(`[data-part=rail] {\n  color: red;\n  background: url(http://x/a.png);\n}`);
    expect(result.css).toBe(`[data-suit="neon"] [data-part=rail]{color:red}`);
    expect(result.problems).toEqual([expect.objectContaining({ line: 3 })]);
  });

  it("never prints a sequence that would close its <style>", () => {
    const result = run(`[data-part=rail]::after { content: "</style><script>" }`);
    expect(result.problems).toEqual([]);
    expect(result.css).not.toContain("</");
  });

  it("refuses a file over the size cap without reading it", () => {
    const result = run(`/*${"x".repeat(suitLimits.cssBytes)}*/`);
    expect(result.css).toBe("");
    expect(result.problems).toEqual([
      expect.objectContaining({ check: "css", message: expect.stringMatching(/limit/) }),
    ]);
  });
});
