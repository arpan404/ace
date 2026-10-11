/** Model and options selections belong to a settled turn boundary. */
export function hasNextTurnSelection(input: { model?: unknown; options?: unknown }): boolean {
  return input.model !== undefined || input.options !== undefined;
}
