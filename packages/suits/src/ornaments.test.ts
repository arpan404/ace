import { describe, expect, test } from "vitest";
import { inspectSuit, plan, type SuitEntry } from "./folder.ts";
import { ornamentByteLimit, sanitiseOrnament } from "./ornaments.ts";
import { regionOrnaments } from "./regions.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const served: Record<string, string> = {
  "assets/stamp.png": "http://127.0.0.1:1/v1/suits/neon/h/g/assets/stamp.png",
};
const clean = (text: string, path = "assets/plate.svg") =>
  sanitiseOrnament({ path, index: 0, bytes: bytes(text), asset: (asset) => served[asset] });

describe("ornament sanitiser: what is dropped and reported", () => {
  test.each([
    ["a script element", `<svg><script>alert(1)</script><rect/></svg>`, /<script>/],
    ["an event handler", `<svg onload="alert(1)"><rect/></svg>`, /event handler/],
    ["foreignObject", `<svg><foreignObject><div>hi</div></foreignObject></svg>`, /foreignObject/],
    ["an external image", `<svg><image href="https://evil.example/x.png"/></svg>`, /outside/],
    ["a link", `<a href="https://evil.example">go</a>`, /<a>/],
    ["a style element", `<style>body{display:none}</style><div>x</div>`, /<style>/],
    ["a javascript href", `<svg><use href="javascript:alert(1)"/></svg>`, /script or data URL/],
    [
      "an encoded javascript href",
      `<svg><use href="&#106;avascript:alert(1)"/></svg>`,
      /script or data URL/,
    ],
    [
      "style url() off the Suit",
      `<div style="background:url(https://x.example/a.png)">x</div>`,
      /outside/,
    ],
    ["a style expression", `<div style="width:expression(alert(1))">x</div>`, /refused/],
    [
      "an animation that could set an href",
      `<svg><set attributeName="href" to="javascript:x"/></svg>`,
      /<set>/,
    ],
    ["a class", `<div class="fixed inset-0">x</div>`, /class attribute/],
  ])("%s", (_, input, message) => {
    const result = clean(input);
    expect(result.problems.map((problem) => problem.message).join("\n")).toMatch(message);
    expect(result.problems.every((problem) => problem.check === "ornament")).toBe(true);
    expect(result.markup).not.toMatch(
      /script|onload|foreignObject|evil|expression|javascript|class=/i,
    );
  });
});

describe("ornament sanitiser: what survives", () => {
  test.each([
    [
      "a gradient-filled path, its ids kept apart from the app's",
      `<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#f0f"/></linearGradient></defs><path d="M0 0h10" fill="url(#g)"/></svg>`,
      `<svg viewBox="0 0 10 10"><defs><linearGradient id="ace-suit-o0-g"><stop offset="0" stop-color="#f0f"></stop></linearGradient></defs><path d="M0 0h10" fill="url(#ace-suit-o0-g)"></path></svg>`,
    ],
    [
      "an image from the Suit's own assets, as its served URL",
      `<img src="stamp.png" alt="">`,
      `<img src="${served["assets/stamp.png"]}" alt="">`,
    ],
    [
      "inline style with an asset url()",
      `<div style="background: url('stamp.png'); opacity: .5">TOP</div>`,
      `<div style="background:url(&quot;${served["assets/stamp.png"]}&quot;);opacity:.5">TOP</div>`,
    ],
    ["text, escaped", `<span>a &lt; b &amp; c</span>`, `<span>a &lt; b &amp; c</span>`],
    [
      "the xml prolog and comments, gone",
      `<?xml version="1.0"?><!-- hi --><svg></svg>`,
      `<svg></svg>`,
    ],
    ["unclosed elements, closed", `<div><span>x`, `<div><span>x</span></div>`],
  ])("%s", (_, input, output) => {
    const result = clean(input);
    expect(result.problems).toEqual([]);
    expect(result.markup).toBe(output);
  });
});

test("a problem names the file and the line it is on", () => {
  const result = clean(`<svg>\n<rect/>\n<script>x</script></svg>`);
  expect(result.problems).toEqual([
    expect.objectContaining({ check: "ornament", field: "assets/plate.svg", line: 3 }),
  ]);
});

test("an ornament over 64 KiB is refused whole", () => {
  const big = `<svg>${"<rect/>".repeat(ornamentByteLimit / 6)}</svg>`;
  const result = clean(big);
  expect(result.markup).toBe("");
  expect(result.problems[0]?.message).toMatch(/bytes/);
});

test("markup inside a script never opens a tag", () => {
  const result = clean(`<div><script>var s = "<img src=x onerror=alert(1)>";</script>ok</div>`);
  expect(result.markup).toBe("<div>ok</div>");
});

test("ornaments sharing a slot show in suit.json's order, each with its own ids", () => {
  const files = new Map([
    ["assets/a.svg", bytes(`<svg><g id="x"></g></svg>`)],
    ["assets/b.svg", bytes(`<svg><g id="x"></g></svg>`)],
  ]);
  const { ornaments } = regionOrnaments(
    {
      ornaments: [
        { slot: "sidebar-header", asset: "assets/a.svg" },
        { slot: "sidebar-header", asset: "assets/b.svg" },
      ],
    },
    files,
    () => undefined,
  );
  expect(ornaments["sidebar-header"]).toBe(
    `<svg><g id="ace-suit-o0-x"></g></svg><svg><g id="ace-suit-o1-x"></g></svg>`,
  );
});

test("a Suit whose ornament carries a script is not appliable until it is fixed", () => {
  const files = new Map([
    [
      "suit.json",
      bytes(
        JSON.stringify({
          format: 1,
          id: "neon",
          name: "Neon",
          dark: { canvas: "#101014" },
          ornaments: [{ slot: "transcript-top", asset: "assets/plate.svg" }],
        }),
      ),
    ],
    ["assets/plate.svg", bytes(`<svg onclick="x()"></svg>`)],
  ]);
  const entries: SuitEntry[] = [...files].map(([path, data]) => ({
    path,
    kind: "file",
    size: data.byteLength,
  }));
  const { summary } = inspectSuit("neon", files, plan(entries));
  expect(summary.problems).toEqual([
    expect.objectContaining({ check: "ornament", field: "assets/plate.svg", line: 1 }),
  ]);
});
