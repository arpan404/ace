import type { ToolState, TranslationState } from "./state.ts";

/** Published payloads belong to canonical storage. Keep only a bounded late-event window. */
export function retireTool(state: TranslationState, tool: ToolState): void {
  if (state.liveTools.has(tool) || tool.uncertainShell) return;
  tool.retired = true;
  tool.raw = [];
  delete tool.initialRaw;
  delete tool.inputRaw;
  delete tool.originalInput;
  if (state.retiredTools.has(tool)) return;
  if (tool.child && !tool.child.terminal) return;
  const bytes = Buffer.byteLength(
    JSON.stringify({ data: tool.data, input: [...(tool.inputParts ?? [])] }),
  );
  state.retiredTools.set(tool, bytes);
  state.retiredBytes += bytes;
  while (state.retiredTools.size > 1024 || state.retiredBytes > 1024 * 1024) {
    const entry = state.retiredTools.entries().next().value;
    if (!entry) break;
    const [oldest, cost] = entry;
    state.retiredTools.delete(oldest);
    state.retiredBytes -= cost;
    const owned = state.ownedTools.get(oldest.owner.key);
    if (owned?.get(oldest.nativeId) === oldest) owned.delete(oldest.nativeId);
    if (state.tools.get(oldest.nativeId) === oldest) state.tools.delete(oldest.nativeId);
    if (oldest.owner.planTool === oldest) delete oldest.owner.planTool;
    if (oldest.child && state.childTools.get(oldest.child.nativeId) === oldest)
      state.childTools.delete(oldest.child.nativeId);
    state.backgroundTools.delete(oldest);
  }
}

export function renewTool(state: TranslationState, tool: ToolState): void {
  const cost = state.retiredTools.get(tool);
  if (cost === undefined) return;
  state.retiredBytes -= cost;
  state.retiredTools.delete(tool);
}
