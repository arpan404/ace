import type { ContentPart } from "@ace/protocol";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.ts";
export function nativeInput(parts: ContentPart[]): TurnStartParams["input"] {
  return parts.map((part) => {
    if (part.type === "mention") {
      const invocation = part.invocation;
      if (!invocation || (invocation.type !== "skill" && invocation.type !== "mention"))
        throw new Error("Unresolved Codex mention");
      return { type: invocation.type, name: invocation.name, path: invocation.path };
    }
    return part.type === "text"
      ? { type: "text", text: part.text, text_elements: [] }
      : part.type === "image"
        ? { type: "image", url: part.url }
        : part.mimeType?.startsWith("image/")
          ? { type: "localImage", path: part.path }
          : // Codex documents mention items only for app:// connectors and does not show them
            // to the model as text, so a local file reference travels as its path (and text).
            {
              type: "text",
              text: `File: ${part.path}${part.content?.encoding === "text" ? `\n${part.content.data}` : ""}`,
              text_elements: [],
            };
  });
}
