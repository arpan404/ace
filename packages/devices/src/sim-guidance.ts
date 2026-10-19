/**
 * The device how-to. It reaches an agent only in the result of its first start of a device, so
 * threads that never use a simulator carry none of it.
 */
export function simGuidance(simId: string, threadId: string): string {
  const cli = `ace sim <verb> ${simId} --thread ${threadId}`;
  return [
    `Driving ${simId}. Refs first:`,
    "1. Read the screen with sim_ui (pass name, text or role to find). Actionable elements carry refs like @e3; a ref stays valid while its element is on screen.",
    '2. Act on a ref: sim_act {action:"tap", ref:"@e3"}, {action:"type", ref:"@e3", text}, or {action:"ui", ref, uiAction}. Coordinates (x,y) are the fallback for things without a ref.',
    "3. Read again after the screen changes. stale_ref means the element is gone: read again rather than guessing coordinates.",
    "sim_screenshot only for visual checks (it costs more); it works with or without the live view. sim_stop when you finish.",
    `The same tools from a shell, with JSON results and the same refs: ${cli} (verbs: list, start, stop, ui, act, screenshot, logs; ace sim --help).`,
    "lease_required means the person took the device: wait, then sim_start again.",
  ].join("\n");
}
