import { describe, expect, it } from "vitest";
import { withoutLegacyPolyfills } from "./css-polyfills.ts";

const mix = "color-mix(in oklab, var(--foreground) 8%, transparent)";
const supports = (rule: string) => `@supports (color:color-mix(in lab, red, red)){${rule}}`;

describe("withoutLegacyPolyfills", () => {
  it("keeps the color-mix declaration in place of its fallback", () => {
    const css = `.a{color:red;background-color:var(--foreground)}${supports(`.a{background-color:${mix}}`)}.b{color:blue}`;
    expect(withoutLegacyPolyfills(css)).toBe(`.a{color:red;background-color:${mix}}.b{color:blue}`);
  });

  it("splits a selector the minifier merged with others sharing the fallback", () => {
    const css = `.bg-foreground,.bg-foreground\\/8{background-color:var(--foreground)}${supports(`.bg-foreground\\/8{background-color:${mix}}`)}`;
    expect(withoutLegacyPolyfills(css)).toBe(
      `.bg-foreground{background-color:var(--foreground)}.bg-foreground\\/8{background-color:${mix}}`,
    );
  });

  it("replaces fallbacks inside media queries and layers", () => {
    const css = `@layer utilities{@media (hover:hover){.h:hover{outline:2px solid var(--ring)}${supports(`.h:hover{outline:2px solid ${mix}}`)}}}`;
    expect(withoutLegacyPolyfills(css)).toBe(
      `@layer utilities{@media (hover:hover){.h:hover{outline:2px solid ${mix}}}}`,
    );
  });

  it("drops the custom property reset for browsers without @property", () => {
    const css =
      '/*! tailwindcss */@layer properties{@supports (((-webkit-hyphens:none)) and (not (margin-trim:inline))){*,:before,:after,::backdrop{--tw-shadow:0 0 #0000;--tw-content:""}}}@layer theme{:root{--x:1}}';
    expect(withoutLegacyPolyfills(css)).toBe("/*! tailwindcss */@layer theme{:root{--x:1}}");
  });

  it("leaves a color-mix block alone when the rule before it has no fallback", () => {
    const css = `.a{color:red}${supports(`.b{background-color:${mix}}`)}`;
    expect(withoutLegacyPolyfills(css)).toBe(css);
  });

  it("leaves other @supports blocks and properties layers alone", () => {
    const css =
      "@supports (display:grid){.g{display:grid}}@layer properties{.p{color:red}}@supports (animation-timeline:scroll()){.s{opacity:1}}";
    expect(withoutLegacyPolyfills(css)).toBe(css);
  });

  it("is not confused by braces and semicolons in strings, escapes and urls", () => {
    const css = `.content-\\[\\"\\{\\"\\]:before{content:"{;}";background:url(data:image/svg+xml;utf8,x) var(--a)}${supports(`.content-\\[\\"\\{\\"\\]:before{background:url(data:image/svg+xml;utf8,x) ${mix}}`)}`;
    expect(withoutLegacyPolyfills(css)).toBe(
      `.content-\\[\\"\\{\\"\\]:before{content:"{;}";background:url(data:image/svg+xml;utf8,x) ${mix}}`,
    );
  });
});
