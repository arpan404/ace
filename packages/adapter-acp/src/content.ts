import { fileURLToPath, pathToFileURL } from "node:url";
import type { ContentPart } from "@ace/protocol";
import { object, string } from "./data.ts";
export function decodeContent(value: unknown): ContentPart[] {
  const content = object(value);
  if (content["type"] === "text" && typeof content["text"] === "string")
    return [{ type: "text", text: content["text"] }];
  if (
    content["type"] === "image" &&
    typeof content["data"] === "string" &&
    typeof content["mimeType"] === "string"
  )
    return [
      {
        type: "image",
        mimeType: content["mimeType"],
        url: `data:${content["mimeType"]};base64,${content["data"]}`,
      },
    ];
  if (content["type"] === "resource_link" && typeof content["uri"] === "string") {
    try {
      return [{ type: "file", path: fileURLToPath(content["uri"]) }];
    } catch {
      return [];
    }
  }
  return [];
}
export function encodeContent(part: ContentPart): unknown {
  if (part.type === "text") return part;
  if (part.type === "file")
    if (part.content)
      return {
        type: "resource",
        resource: {
          uri: pathToFileURL(part.path).href,
          mimeType: part.mimeType ?? "application/octet-stream",
          ...(part.content.encoding === "text"
            ? { text: part.content.data }
            : { blob: part.content.data }),
        },
      };
  if (part.type === "file")
    return {
      type: "resource_link",
      uri: pathToFileURL(part.path).href,
      name: part.path.split("/").at(-1) ?? part.path,
      ...(part.mimeType ? { mimeType: part.mimeType } : {}),
    };
  const match = /^data:[^;]+;base64,(.*)$/s.exec(part.url);
  if (!match) throw new Error("ACP image input requires a base64 data URL");
  return { type: "image", mimeType: part.mimeType, data: string(match[1]) };
}
