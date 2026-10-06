import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContentPart } from "@ace/protocol";
export function messageId(now: number, sequence: number, entropy: string): string {
  const prefix = ((BigInt(now) << 12n) + BigInt(sequence % 4096)) & 0xffffffffffffn;
  return `msg_${prefix.toString(16).padStart(12, "0")}${entropy}`;
}
export function selectedModel(model?: string) {
  if (model === undefined) return undefined;
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1)
    throw new Error("OpenCode model must be provider/model");
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}
export function promptBody(input: ContentPart[], cwd: string, id: string) {
  const text: string[] = [],
    files: { uri: string }[] = [];
  for (const part of input) {
    if (part.type === "text") text.push(part.text);
    else if (part.type === "file" && !part.mimeType?.startsWith("image/"))
      text.push(
        `File (${part.mimeType ?? "application/octet-stream"}): ${JSON.stringify(resolve(cwd, part.path))}`,
      );
    else {
      if (part.type === "file" && part.mimeType?.startsWith("image/"))
        throw new Error("OpenCode images require an inline data URI with MIME type");
      files.push({
        uri: part.type === "image" ? part.url : pathToFileURL(resolve(cwd, part.path)).href,
      });
    }
  }
  return { id, text: text.join("\n"), ...(files.length ? { files } : {}) };
}
