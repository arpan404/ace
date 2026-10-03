import { fileURLToPath } from "node:url";
import type { ContentPart } from "@ace/protocol";
import type { Projection } from "./projection.ts";
/** Convert prepared native context into the adapter contract without reading blobs again. */
export function canonicalContext(projection: Projection): ContentPart[] {
  return projection.input.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "localImage") return { type: "file", path: part.path, mimeType: "image/*" };
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
    if (part.type === "resource" && "text" in part.resource)
      return { type: "text", text: part.resource.text };
    throw new Error("Prepared documents require a native document consumer");
  });
}
