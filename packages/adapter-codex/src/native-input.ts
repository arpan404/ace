import type { ContentPart } from "@ace/protocol";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.ts";
export function nativeInput(parts: ContentPart[]): TurnStartParams["input"] {
  return parts.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text, text_elements: [] }
      : part.type === "image"
        ? { type: "image", url: part.url }
        : { type: "mention", name: part.path.split("/").at(-1) ?? part.path, path: part.path },
  );
}
