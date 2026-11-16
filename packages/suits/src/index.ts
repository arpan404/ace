/*
 * Suits (ADR 0150): a Suit's palette built over its base theme, and the checks it must pass.
 * Pure, so the daemon and every client resolve and check a Suit the same way. Reading a Suit's
 * folder (`@ace/suits/folder`) needs Node's crypto and stays out of this entry.
 */
export * from "./palette.ts";
export { fontProblems, parseManifest, readabilityProblems, thumbnailProblems } from "./checks.ts";
export * from "./limits.ts";
export * from "./reveal.ts";
export { ornamentByteLimit, sanitiseOrnament } from "./ornaments.ts";
export { isSceneFile, regionOrnaments, regionScenes, scenePageFor } from "./regions.ts";
export { easeColour, strongestColour, tintedVeil, videoAccent } from "./video-palette.ts";
export { pickVideoSource, showsSharp, videoSizeLabel, type ProbedVideo } from "./video-source.ts";
