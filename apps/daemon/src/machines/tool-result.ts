import type { MachineToolResult } from "@ace/protocol";

interface RegistryResult {
  isError?: boolean | undefined;
  content: readonly (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: string }
  )[];
}

/**
 * A tool's result as another machine receives it: text and images only, at most 16 parts
 * (ADR 0105). Other content kinds don't cross machines.
 */
export function toolResult(result: RegistryResult): MachineToolResult {
  const content: MachineToolResult["content"] = [];
  for (const part of result.content) {
    if (content.length >= 16) break;
    if (part.type === "text" && "text" in part) content.push({ type: "text", text: part.text });
    else if (part.type === "image" && "data" in part)
      content.push({ type: "image", data: part.data, mimeType: part.mimeType.slice(0, 64) });
  }
  return { ...(result.isError ? { isError: true } : {}), content };
}
