import { afterEach, describe, expect, it } from "vitest";
import { fakeSuit } from "@/test/fake-suits.ts";
import { suitSheets } from "./suit-css.ts";
import { revealCeiling } from "@ace/suits";
import { themes } from "@ace/themes";
import { regionRules, revealDeclarations } from "./suit-layers.ts";

/*
 * The guard against a Suit's CSS. The daemon already refuses these rules in suit.css; here they
 * reach the page anyway, as if the sanitiser had missed them, and the guard must still win.
 *
 * jsdom parses `@layer` but leaves layered rules out of computed styles, so the page's sheet is
 * flattened in layer order (suit.regions, suit, guard, then unlayered) before it applies. The
 * hostile rules are written as specific as the guard's, so a property the guard stops covering
 * fails here; a browser's layers then make the guard win at any specificity.
 */

const hostile = [
  `[data-suit="neon"] :is([data-part="approval-strip"]){visibility:hidden;opacity:0;pointer-events:none}`,
  `[data-suit="neon"] [data-part="status-icon"][data-state="working"]{color:rgb(255, 0, 255)}`,
  `[data-suit="neon"] [data-part="sidebar"]{color:rgb(255, 0, 255)}`,
].join("\n");

/** `#rrggbb` as computed styles print it. */
const rgb = (hex: string) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
};

function render(css: string) {
  const suit = { ...fakeSuit({ id: "neon", dark: { canvas: "#101014" } }), css };
  const root = document.documentElement;
  root.setAttribute("data-suit", "neon");
  root.setAttribute("data-scheme", "dark");
  const style = document.createElement("style");
  style.textContent = suitSheets(suit);
  document.head.append(style);
  style.textContent = flattened(style);
  document.body.innerHTML = `
    <div data-part="sidebar">
      <div data-part="approval-strip">Allow the command?</div>
      <span data-part="status-icon" data-state="working">●</span>
    </div>`;
}

function find(part: string) {
  const element = document.querySelector(`[data-part="${part}"]`);
  if (!element) throw new Error(part);
  return getComputedStyle(element);
}

const layerOrder = ["suit.regions", "suit", "guard"];

/** The sheet's rules with each `@layer` block unwrapped, in cascade order for normal rules. */
function flattened(style: HTMLStyleElement): string {
  const layered = new Map<string, string[]>(layerOrder.map((name) => [name, []]));
  const plain: string[] = [];
  for (const rule of style.sheet?.cssRules ?? []) {
    if (rule instanceof CSSLayerBlockRule) {
      const into = layered.get(rule.name);
      if (!into) throw new Error(`unexpected layer ${rule.name}`);
      for (const inner of rule.cssRules) into.push(inner.cssText);
    } else if (!(rule instanceof CSSLayerStatementRule)) plain.push(rule.cssText);
  }
  return [...layerOrder.flatMap((name) => layered.get(name) ?? []), ...plain].join("\n");
}

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-suit");
  document.documentElement.removeAttribute("data-scheme");
});

describe("ace's guard over a Suit's CSS", () => {
  it("keeps the approval strip shown, opaque and clickable over a rule that hides it", () => {
    render(hostile);
    const strip = find("approval-strip");
    expect(strip.visibility).toBe("visible");
    expect(strip.opacity).toBe("1");
    expect(strip.pointerEvents).toBe("auto");
  });

  it("keeps a status icon in ace's status colour over a rule that recolours it", () => {
    render(hostile);
    const icon = find("status-icon");
    expect(icon.color).not.toBe("rgb(255, 0, 255)");
    const working = getComputedStyle(document.documentElement)
      .getPropertyValue("--status-working")
      .trim();
    expect(working).not.toBe("");
    // ace's own status token (jsdom leaves var() unresolved in colours; a browser resolves it).
    expect([rgb(working), "var(--status-working)"]).toContain(icon.color);
    // The Suit's colour still reaches parts it may restyle.
    expect(find("sidebar").color).toBe("rgb(255, 0, 255)");
  });
});

describe("region backgrounds", () => {
  it("reads only the region properties a Suit sets, so an unset one keeps ace's background", () => {
    expect(
      regionRules(
        "neon",
        `[data-suit="neon"] [data-part=app]{--suit-sidebar-background:red;--suit-rail-shadow:none}`,
      ),
    ).toEqual([
      `[data-suit="neon"] [data-part="rail"]{box-shadow:var(--suit-rail-shadow)}`,
      `[data-suit="neon"] [data-part="sidebar"]{background:var(--suit-sidebar-background)}`,
    ]);
    expect(regionRules("neon", `[data-suit="neon"] [data-part=app]{color:red}`)).toEqual([]);
  });
  it("gives the side panel its background, border, shadow and backdrop filter", () => {
    const css = `[data-suit="neon"] [data-part=app]{--suit-right-panel-background:url(a.png);--suit-right-panel-border:1px solid red;--suit-right-panel-shadow:none;--suit-right-panel-backdrop-filter:blur(4px)}`;
    expect(regionRules("neon", css)).toEqual([
      `[data-suit="neon"] [data-part="right-panel"]{background:var(--suit-right-panel-background);border:var(--suit-right-panel-border);box-shadow:var(--suit-right-panel-shadow);backdrop-filter:var(--suit-right-panel-backdrop-filter)}`,
    ]);
  });

  it("keeps the side panel solid by default and holds a Suit's reveal to what its text allows", () => {
    const palette = themes.ace.dark;
    expect(revealDeclarations({}, palette)["--suit-right-panel-reveal"]).toBe("0");
    const wanted = Number(
      revealDeclarations({ reveal: { "right-panel": 0.4 } }, palette)["--suit-right-panel-reveal"],
    );
    expect(wanted).toBeGreaterThan(0);
    expect(wanted).toBeLessThanOrEqual(0.4);
    const ceiling = revealCeiling({ text: palette.t1, surface: palette.sidebar });
    const all = Number(
      revealDeclarations({ reveal: { "right-panel": 1 } }, palette)["--suit-right-panel-reveal"],
    );
    expect(all).toBe(ceiling);
    expect(all).toBeLessThan(1);
  });
});
