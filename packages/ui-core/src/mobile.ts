/*
 * Display logic the native iOS and Android apps share: status words and colour tokens, inbox
 * grouping and transcript row content. Platform code maps the token keys to its own colours and
 * draws the rows; it never derives status or groups threads itself.
 */
export * from "./mobile-status.ts";
export * from "./mobile-inbox.ts";
export * from "./mobile-transcript.ts";
export { snoozePresets, type SnoozePreset } from "./snooze.ts";
