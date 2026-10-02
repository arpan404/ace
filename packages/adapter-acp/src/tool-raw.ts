import type { RawPayload } from "@ace/protocol";
import type { ToolState } from "./state.ts";
import { object, raw, string } from "./data.ts";
/** Keep the assembled native input beside the complete latest frame, never refresh history. */
export function retainToolRaw(tool: ToolState, payload: RawPayload): void {
  const update = object(object(object(payload.data)["params"])["update"]);
  if (!tool.inputRaw || Object.hasOwn(update, "rawInput") || Object.hasOwn(update, "name")) {
    const name = string(object(tool.data["rawInput"])["_toolName"] ?? tool.data["name"]);
    tool.inputRaw = raw(
      { rawInput: tool.data["rawInput"] ?? {}, ...(name ? { nativeName: name } : {}) },
      "acp/tool-input",
      name,
    );
  }
  tool.raw = [tool.inputRaw, payload];
}
