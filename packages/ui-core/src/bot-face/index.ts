/**
 * Bot character faces (direction G): the pure model (fields, per-body rules, exclusions, repair,
 * shuffle, names, colours, states) and the face geometry as SVG markup. No DOM, no I/O; a native
 * client ports the same tables and numbers.
 */
export * from "./model.ts";
export * from "./rules.ts";
export * from "./shuffle.ts";
export * from "./names.ts";
export * from "./palette.ts";
export * from "./parse.ts";
export * from "./states.ts";
export {
  botFaceMarkup,
  botFaceColourVars,
  botFaceTiltDeg,
  faceTier,
  type FaceTier,
} from "./draw-face.ts";
export * from "./editor.ts";
