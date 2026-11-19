import { fileURLToPath, pathToFileURL } from "node:url";
import type { ContentPart } from "@ace/protocol";
import { base64DataUrl } from "@ace/provider-kit/data-url";
import { object } from "./data.ts";
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
  if (part.type === "mention") throw new Error("Unresolved ACP mention");
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
  const image = base64DataUrl(part.url);
  if (!image) throw new Error("ACP image input requires a base64 data URL");
  return { type: "image", mimeType: part.mimeType, data: image.data };
}
