/*
 * Suits (ADR 0150): a Suit's palette built over its base theme, and the checks it must pass.
 * Pure, so the daemon and every client resolve and check a Suit the same way. Reading a Suit's
 * folder (`@ace/suits/folder`) needs Node's crypto and stays out of this entry.
 */
export * from "./palette.ts";
export { fontProblems, parseManifest, readabilityProblems } from "./checks.ts";
export * from "./limits.ts";
