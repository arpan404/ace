import { fileURLToPath } from "node:url";
import type { ContentPart } from "@ace/protocol";
import type { Projection } from "./projection.ts";
/** Convert prepared native context into the adapter contract without reading blobs again. */
export function canonicalContext(projection: Projection): ContentPart[] {
  return projection.input.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "localImage")
      return { type: "file", path: part.path, mimeType: part.mimeType };
    if (part.type === "file" && part.url.startsWith("data:"))
      return { type: "image", mimeType: part.mime, url: part.url };
    if (part.type === "file")
      return { type: "file", path: fileURLToPath(part.url), mimeType: part.mime };
    if (part.type === "image") {
      if ("source" in part)
        return {
          type: "image",
          mimeType: part.source.media_type,
          url: `data:${part.source.media_type};base64,${part.source.data}`,
        };
      return {
        type: "image",
        mimeType: part.mimeType,
        url: `data:${part.mimeType};base64,${part.data}`,
      };
    }
    if (
      part.type === "resource" &&
      !part.resource.uri.startsWith("file:") &&
      "text" in part.resource
    )
      return { type: "text", text: part.resource.text };
    if (part.type === "resource")
      return {
        type: "file",
        path: fileURLToPath(part.resource.uri),
        mimeType: part.resource.mimeType,
        content:
          "text" in part.resource
            ? { encoding: "text", data: part.resource.text }
            : { encoding: "base64", data: part.resource.blob },
      };
    return {
      type: "file",
      path: part.path,
      name: part.title,
      mimeType: part.source.media_type,
      content: {
        encoding: part.source.type === "text" ? "text" : "base64",
        data: part.source.data,
      },
    };
  });
}
