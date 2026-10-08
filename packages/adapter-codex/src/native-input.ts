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
          : { type: "mention", name: part.path.split("/").at(-1) ?? part.path, path: part.path };
  });
}
