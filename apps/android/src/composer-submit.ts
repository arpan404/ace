/**
 * Composer Return-key behavior. iOS sends on `\n` when
 * `ace.keyboard.returnSends` is on (`NativeTextInput.shouldChangeText`);
 * Android mirrors it through `submitBehavior` plus `onSubmitEditing`.
 * Fixture builds keep probe ownership of the Return key so input metrics
 * stay measurable there; the opt-in only changes production composing.
 */
export function resolveComposerSubmitBehavior(
  returnSends: boolean,
  instrumented: boolean,
): "submit" | "newline" {
  if (instrumented) return "submit";
  return returnSends ? "submit" : "newline";
}

/** Whether a Return press should send the draft (production opt-in only). */
export function shouldSubmitOnReturn(returnSends: boolean, instrumented: boolean): boolean {
  return !instrumented && returnSends;
}
