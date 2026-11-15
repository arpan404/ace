// @vitest-environment jsdom
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as icons from "./index.ts";
import type { Icon, IconWeight } from "./glyph.ts";

const html = (icon: Icon, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(icon, props));
const doc = (markup: string) => new DOMParser().parseFromString(markup, "image/svg+xml");
const caretStroke = (weight: IconWeight) =>
  Number(
    doc(html(icons.CaretDownIcon, { weight })).querySelector("path")?.getAttribute("stroke-width"),
  );

describe("ace icons", () => {
  it("draws a filled icon as a solid body with its details cut out", () => {
    const filled = doc(html(icons.CheckCircleIcon, { weight: "fill" }));
    const ring = filled.querySelector("circle");
    expect(ring?.getAttribute("fill")).toBe("currentColor");
    const cut = filled.querySelector("mask path");
    expect(cut?.getAttribute("stroke")).toBe("black");
    expect(ring?.parentElement?.getAttribute("mask")).toMatch(/^url\(#.+\)$/);

    const outline = doc(html(icons.CheckCircleIcon));
    expect(outline.querySelector("mask")).toBeNull();
    expect(outline.querySelector("circle")?.getAttribute("fill")).toBe("none");
  });

  it("tints the body in two-tone and keeps details as strokes", () => {
    const tinted = doc(html(icons.TrayIcon, { weight: "duotone" }));
    const [body, lip] = [...tinted.querySelectorAll("path")];
    expect(body?.getAttribute("fill-opacity")).toBe("0.2");
    expect(lip?.getAttribute("fill")).toBe("none");
  });

  it("keeps each instance's masks apart when two filled icons share a page", () => {
    const page = doc(
      `<svg xmlns="http://www.w3.org/2000/svg">${renderToStaticMarkup(
        createElement(
          Fragment,
          null,
          createElement(icons.CheckCircleIcon, { weight: "fill" }),
          createElement(icons.CheckCircleIcon, { weight: "fill" }),
        ),
      )}</svg>`,
    );
    const ids = [...page.querySelectorAll("mask")].map((mask) => mask.id);
    expect(new Set(ids).size).toBe(2);
    const used = [...page.querySelectorAll("[mask]")].map((g) => g.getAttribute("mask"));
    expect(used.toSorted()).toEqual(ids.map((id) => `url(#${id})`).toSorted());
  });

  it("keeps the bot's eyes solid in outline and cuts them out of its filled head", () => {
    const outline = doc(html(icons.RobotIcon));
    const eyes = [...outline.querySelectorAll("path")].filter(
      (p) => p.getAttribute("fill") === "currentColor",
    );
    expect(eyes).toHaveLength(2);
    const filled = doc(html(icons.RobotIcon, { weight: "fill" }));
    expect(filled.querySelectorAll("mask path[fill='black']")).toHaveLength(2);
  });

  it("hides the back bubble only where the front one sits", () => {
    const threads = doc(html(icons.ChatsCircleIcon));
    const tucked = threads.querySelector("g[mask]");
    const hole = threads.querySelector("mask circle[fill='black']");
    expect(tucked?.querySelector("path")).not.toBeNull();
    expect(hole?.getAttribute("cx")).toBe("9.5");
    expect(threads.querySelectorAll(":scope > path")).toHaveLength(1);
  });

  it("takes size, colour, mirroring, a title and plain svg props", () => {
    const svg = doc(
      html(icons.CaretRightIcon, {
        size: 14,
        color: "red",
        mirrored: true,
        alt: "Next",
        className: "row-caret",
        "aria-hidden": true,
      }),
    ).documentElement;
    expect(svg.getAttribute("width")).toBe("14");
    expect(svg.getAttribute("class")).toBe("row-caret");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("style")).toContain("scaleX(-1)");
    expect(svg.querySelector("title")?.textContent).toBe("Next");
    expect(svg.querySelector("path")?.getAttribute("stroke")).toBe("red");
  });

  it("draws a heavier stroke at bold", () => {
    expect(caretStroke("bold")).toBeGreaterThan(caretStroke("regular"));
  });

  it("draws every icon in every weight with finite coordinates", () => {
    const weights: IconWeight[] = ["regular", "bold", "fill", "duotone"];
    for (const [name, icon] of Object.entries(icons)) {
      if (!name.endsWith("Icon")) continue;
      for (const weight of weights) {
        const markup = html(icon as Icon, { weight });
        expect(markup, `${name} ${weight}`).toMatch(/<(path|circle)/);
        expect(markup, `${name} ${weight}`).not.toMatch(/NaN|Infinity/);
      }
    }
  });
});
