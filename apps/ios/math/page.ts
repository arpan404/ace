import { renderToString } from "katex";
import { renderTex } from "@ace/ui-core/math-render";

/*
 * The phone's math page: KaTeX, the web's own renderer, with the web's safety settings
 * (`@ace/ui-core/math-render`), in an offscreen web view the app keeps (`MathRenderer`). Each
 * call typesets one formula at a font size in black on nothing, so the app can draw it as a
 * template image in any ink, and answers its size and where its baseline falls; null when KaTeX
 * refuses it, so the app keeps the formula's text form.
 */

export interface MathBox {
  /** The region holding the drawn formula, with room around it, for the snapshot. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Distance from the top of the region to the formula's baseline, in points. */
  baseline: number;
}

async function typeset(tex: string, display: boolean, size: number): Promise<MathBox | null> {
  const host = document.getElementById("math");
  const html = renderTex(renderToString, tex, display);
  if (!host || html === undefined) return null;
  host.style.fontSize = `${size}px`;
  // A zero-height mark on the baseline, after the formula, says where the baseline is.
  host.innerHTML = `${html}<span id="baseline"></span>`;
  await document.fonts.ready;
  const box = host.getBoundingClientRect();
  const mark = document.getElementById("baseline")?.getBoundingClientRect();
  if (!mark || !box.width || !box.height) return null;
  // KaTeX's glyphs, scripts and stacked rows reach well past the boxes holding them, so the
  // region is the box with room on every side; the app crops it to what was drawn.
  const room = Math.ceil(size * 2);
  const x = Math.max(0, Math.floor(box.left) - room);
  const y = Math.max(0, Math.floor(box.top) - room);
  return {
    x,
    y,
    width: Math.ceil(box.right) + room - x,
    height: Math.ceil(box.bottom) + room - y,
    baseline: mark.top - y,
  };
}

Object.assign(globalThis, { aceMath: typeset });
