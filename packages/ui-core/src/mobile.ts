/*
 * Display logic the native iOS and Android apps share: status words and colour tokens, inbox
 * grouping, transcript row content, and the Agents and Changes sheets. Platform code maps the
 * token keys to its own colours and draws the rows; it never derives status or groups threads
 * itself.
 */
export * from "./mobile-status.ts";
export * from "./mobile-inbox.ts";
export * from "./mobile-transcript.ts";
export * from "./mobile-agents.ts";
export * from "./mobile-changes.ts";
export { snoozePresets, type SnoozePreset } from "./snooze.ts";
export * from "./mobile-machines.ts";
/** Git and forge refusal codes in the same words the web shows. */
export { actionErrorText } from "./action-errors.ts";
export { checkoutOf } from "./checkout.ts";
export { mergeMethods } from "./pull-request.ts";
