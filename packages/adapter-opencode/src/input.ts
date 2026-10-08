import { extname, resolve } from "node:path";
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
  const commands: { name: string; arguments: string }[] = [];
  const agents: { name: string; mention: { start: number; end: number; text: string } }[] = [];
  const skills: { id: string; mention: { start: number; end: number; text: string } }[] = [];
  let textLength = 0;
  const text: string[] = [],
    files: { uri: string }[] = [];
  for (const part of input) {
    if (part.type === "mention") {
      const native = part.invocation;
      const label = `${native?.type === "agent" ? "@" : "/"}${part.name}`;
      const start = textLength;
      const mention = { start, end: start + label.length, text: label };
      if (native?.type === "agent") agents.push({ name: native.name, mention });
      else if (native?.type === "skill") skills.push({ id: native.path, mention });
      else if (native?.type === "slash")
        commands.push({ name: native.name, arguments: part.arguments });
      else throw new Error("Unresolved OpenCode mention");
      const argumentsText = native.type !== "slash" && part.arguments ? ` ${part.arguments}` : "";
      text.push(label + argumentsText);
      textLength += label.length + argumentsText.length;
    } else if (part.type === "text") {
      text.push(part.text);
      textLength += part.text.length;
    } else if (
      part.type === "file" &&
      !part.mimeType?.startsWith("image/") &&
      !(part.mimeType === undefined && /^\.(png|jpe?g|gif|webp)$/i.test(extname(part.path)))
    ) {
      const fileText = `File (${part.mimeType ?? "application/octet-stream"}): ${JSON.stringify(resolve(cwd, part.path))}`;
      text.push(fileText);
      textLength += fileText.length;
    } else {
      if (part.type === "file" && part.mimeType?.startsWith("image/"))
        throw new Error("OpenCode images require an inline data URI with MIME type");
      files.push({
        uri: part.type === "image" ? part.url : pathToFileURL(resolve(cwd, part.path)).href,
      });
    }
  }
  return {
    id,
    text: text.join(input.some((p) => p.type === "mention") ? "" : "\n"),
    ...(files.length ? { files } : {}),
    ...(agents.length ? { agents } : {}),
    ...(skills.length ? { skills } : {}),
    commands,
  };
}
