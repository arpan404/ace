import { glyph } from "../glyph.ts";
import { rect } from "../geometry.ts";
import { line, shape, type Part } from "../parts.ts";

/** A padlock's body; every lock icon shares it. */
export const lockBody = (): Part => shape(rect(4.5, 10, 15, 11, 3.5));

/** The shackle, shut. */
export const shackleShut = (): Part => line("M8 10V7.25a4 4 0 0 1 8 0V10");

/** The shackle, swung open on its left leg. */
export const shackleOpen = (): Part => line("M8 10V7.25a4 4 0 0 1 7.75-1.4");

/** Locked, or private: a plain padlock. */
export const LockSimpleIcon = /* @__PURE__ */ glyph("LockSimple", () => [
  lockBody(),
  shackleShut(),
]);
