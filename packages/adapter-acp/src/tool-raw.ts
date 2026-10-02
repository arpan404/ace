import type { InlineRawPayload } from "./data.ts";
import type { ToolState } from "./state.ts";
import { object, raw, string, type Data } from "./data.ts";
/** Original input, interpreted fields and latest change stay live; opaque parts are assembled once. */
export function retainToolRaw(tool: ToolState, payload: InlineRawPayload, update: Data): void {
  tool.initialRaw ??= payload;
  const value = update["rawInput"];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const input = object(value);
    const parts = (tool.inputParts ??= new Map());
    for (const [key, data] of Object.entries(input)) parts.set(key, data);
    if (!tool.originalInput && Object.keys(input).length) tool.originalInput = input;
  }
  if (!tool.inputRaw || Object.hasOwn(update, "rawInput") || typeof update["name"] === "string") {
    const name = string(object(tool.data["rawInput"])["_toolName"] ?? tool.data["name"]);
    tool.inputRaw = raw(
      {
        initialFrame: tool.initialRaw.data,
        rawInput: tool.originalInput ?? {},
        currentInput: tool.data["rawInput"] ?? {},
        ...(name ? { nativeName: name } : {}),
      },
      "acp/tool-input",
      name,
    );
  }
  tool.raw = [tool.inputRaw, payload];
}
/** Terminal snapshots retain all partial input fields; ordinary changes never copy that history. */
export function completeToolRaw(tool: ToolState): Data | undefined {
  if (!tool.inputRaw) return;
  const input = Object.fromEntries(tool.inputParts ?? []);
  tool.inputRaw = raw(
    {
      ...object(tool.inputRaw.data),
      rawInput: input,
    },
    "acp/tool-input",
    tool.inputRaw.name,
  );
  tool.raw[0] = tool.inputRaw;
  return input;
}
