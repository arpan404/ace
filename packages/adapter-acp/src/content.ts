import { fileURLToPath, pathToFileURL } from "node:url";
import type { ContentPart } from "@ace/protocol";
import { base64DataUrl } from "@ace/provider-kit/data-url";
import { object, string } from "./data.ts";
/**
 * Native content as parts ace can show. A kind ace has no part for stays visible as a short
 * text naming it; the complete native content is always on the item's raw frame.
 */
export function decodeContent(value: unknown): ContentPart[] {
  const content = object(value);
  const uri = string(content["uri"]);
  switch (content["type"]) {
    case "text":
      return typeof content["text"] === "string" ? [{ type: "text", text: content["text"] }] : [];
    case "image": {
      const data = string(content["data"]);
      const mimeType = string(content["mimeType"]) || sniffImage(data);
      if (data) return [{ type: "image", mimeType, url: `data:${mimeType};base64,${data}` }];
      // A remote image stays a link: ace never fetches a URL the agent named.
      return reference(uri, "", mimeType);
    }
    case "resource_link":
      return reference(uri, string(content["name"]), string(content["mimeType"]));
    case "resource": {
      const resource = object(content["resource"]);
      return reference(string(resource["uri"]), "", string(resource["mimeType"]));
    }
    case "audio":
      return [{ type: "text", text: `[audio${mimeSuffix(string(content["mimeType"]))}]` }];
    default:
      return [];
  }
}
function reference(uri: string, name: string, mimeType: string): ContentPart[] {
  if (uri.startsWith("file:"))
    try {
      return [
        {
          type: "file",
          path: fileURLToPath(uri),
          ...(mimeType ? { mimeType } : {}),
          ...(name ? { name: name.slice(0, 255) } : {}),
        },
      ];
    } catch {
      // A malformed file URI is still a reference the person should see.
    }
  return uri ? [{ type: "text", text: uri }] : [];
}
function mimeSuffix(mimeType: string): string {
  return mimeType ? ` ${mimeType}` : "";
}
/** ACP requires an image's MIME type, but a missing one should not hide the image. */
function sniffImage(base64: string): string {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  if (base64.startsWith("UklGR")) return "image/webp";
  return "image/png";
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
