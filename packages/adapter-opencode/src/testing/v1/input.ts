import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContentPart } from "@ace/protocol";
/** Native IDs sort by a 48-bit time/counter prefix before their random suffix. */
export function messageId(now: number, sequence: number, entropy: string): string {
  const time = ((BigInt(now) << 12n) + BigInt(sequence % 4096)) & 0xffffffffffffn;
  return `msg_${time.toString(16).padStart(12, "0")}${entropy}`;
}
export function promptBody(input: ContentPart[], cwd: string, id: string, model?: string) {
  const slash = model?.indexOf("/") ?? -1;
  if (model !== undefined && (slash < 1 || slash === model.length - 1))
    throw new Error("OpenCode model must be provider/model");
  return {
    messageID: id,
    parts: input.map((part) =>
      part.type === "text"
        ? part
        : part.type === "image"
          ? { type: "file", mime: part.mimeType, url: part.url }
          : {
              type: "file",
              mime: part.mimeType ?? "text/plain",
              url: pathToFileURL(resolve(cwd, part.path)).href,
            },
    ),
    ...(model === undefined
      ? {}
      : { model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } }),
  };
}
