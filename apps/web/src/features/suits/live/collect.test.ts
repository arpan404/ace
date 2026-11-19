import { afterEach, expect, it } from "vitest";
import { colourReader, readColours } from "./collect.ts";
import { worstContrast } from "./colour-check.ts";
import type { SceneFrame } from "./scene-sample.ts";

/*
 * Reading the rendered page for the live contrast check. jsdom has no layout, so boxes are given
 * by hand; colours and opacity come from inline styles, which jsdom computes.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const placed = <T extends Element>(element: T): T => {
  element.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 20 });
  return element;
};

/** A scene host as the app draws one: the scene frame, a veil over it, then the content. */
function sceneWithVeil(veil: string) {
  document.body.innerHTML = `
    <div data-part="header" style="background-color: rgba(0, 0, 0, 0)">
      <iframe></iframe>
      <div data-suit-veil style="${veil}"></div>
      <div><span>Stage title</span></div>
    </div>`;
  const host = document.querySelector('[data-part="header"]') as HTMLElement;
  placed(host.querySelector("span") as HTMLElement);
  const scene: SceneFrame = {
    host,
    veils: [...host.querySelectorAll("[data-suit-veil]")],
    // One black cell: the scene is dark everywhere.
    grid: {
      columns: 1,
      rows: 1,
      pixels: [0, 0, 0, 255],
      box: { left: 0, top: 0, width: 400, height: 40 },
    },
  };
  return { host, scene };
}

it("text over a scene keeps its own colour under a veil, which only tints the backdrop", () => {
  const { scene } = sceneWithVeil("background-color: rgb(255, 255, 255); opacity: 0.5");
  const reading = readColours(document.body, [scene], colourReader(document));
  const [sample] = reading.samples;
  expect(sample?.part).toBe("header");
  const measured = sample && worstContrast({ ...sample, fg: [255, 255, 255, 1] });
  // White words on a black scene half covered in white: the words stay white, the ground is
  // mid-grey, so they read at about 4:1 rather than not at all.
  expect(measured?.fg.map(Math.round)).toEqual([255, 255, 255]);
  expect(measured?.bg.map(Math.round)).toEqual([128, 128, 128]);
  expect(measured?.ratio).toBeGreaterThan(3.9);
});

it("a veil's gradient counts its worst stop as the ground under the text", () => {
  const { scene } = sceneWithVeil(
    "background-image: linear-gradient(rgb(255, 255, 255), rgb(0, 0, 0))",
  );
  const [sample] = readColours(document.body, [scene], colourReader(document)).samples;
  const measured = sample && worstContrast({ ...sample, fg: [0, 0, 0, 1] });
  expect(measured?.ratio).toBeCloseTo(1, 5);
});

it("a Suit's ornament is decoration, so its art is never read as the region's icon", () => {
  document.body.innerHTML = `
    <div data-part="sidebar" style="background-color: rgb(13, 11, 34)">
      <div data-ornament="sidebar-header" aria-hidden="true"><svg><rect fill="#f2efff" /></svg></div>
      <svg style="color: rgb(242, 239, 255); fill: currentColor"></svg>
    </div>`;
  for (const svg of document.querySelectorAll("svg")) placed(svg);
  const [sample] = readColours(document.body, [], colourReader(document)).samples;
  expect(sample?.kind).toBe("mark");
  expect(sample?.fg).toEqual([242, 239, 255, 1]);
});
