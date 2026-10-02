import type { RawPayload } from "@ace/protocol";
import type { ToolState } from "./state.ts";
/** Initial input plus latest change, never a republished transcript. Full frames remain in the event log. */
export function retainToolRaw(tool: ToolState, payload: RawPayload): void {
  const initial = tool.raw[0];
  tool.raw = initial ? [initial, payload] : [payload];
}
