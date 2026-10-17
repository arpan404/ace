import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContentPart, ExecutionOptions } from "@ace/protocol";
export function messageId(now: number, sequence: number, entropy: string): string {
  const prefix = ((BigInt(now) << 12n) + BigInt(sequence % 4096)) & 0xffffffffffffn;
  return `msg_${prefix.toString(16).padStart(12, "0")}${entropy}`;
}
export function selectedModel(model?: string, options?: ExecutionOptions) {
  if (model === undefined) return undefined;
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1)
    throw new Error("OpenCode model must be provider/model");
  const variant = options?.["effort"];
  return {
    providerID: model.slice(0, slash),
    id: model.slice(slash + 1),
    ...(typeof variant === "string" ? { variant } : {}),
  };
}
export function promptBody(input: ContentPart[], cwd: string, id: string) {
  const commands: { name: string; arguments: string }[] = [];
  const agents: { name: string; mention: { start: number; end: number; text: string } }[] = [];
  const skills: { id: string; mention: { start: number; end: number; text: string } }[] = [];
  let textLength = 0;
  const text: string[] = [],
    files: { uri: string; mention?: { start: number; end: number; text: string } }[] = [],
    labels: (string | undefined)[] = [];
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
      // OpenCode inlines text files and sends PDFs as media; other binaries would be dropped.
      part.mimeType !== "text/plain" &&
      part.mimeType !== "application/pdf" &&
      !(part.mimeType === undefined && /^\.(png|jpe?g|gif|webp)$/i.test(extname(part.path)))
    ) {
      const fileText = `File (${part.mimeType ?? "application/octet-stream"}): ${JSON.stringify(resolve(cwd, part.path))}`;
      text.push(fileText);
      textLength += fileText.length;
    } else {
      // OpenCode 2 reads file:// attachments itself (sniffing MIME and resizing images), so
      // an image path costs a few bytes on the wire instead of an inline data URI.
      files.push({
        uri: part.type === "image" ? part.url : pathToFileURL(resolve(cwd, part.path)).href,
      });
      labels.push(part.type === "file" ? workspaceLabel(cwd, part.path) : undefined);
    }
  }
  const prompt = text.join(input.some((p) => p.type === "mention") ? "" : "\n");
  // The composer writes `@relative/path` for a picked file; OpenCode anchors the file there.
  const anchored = new Set<number>();
  files.forEach((file, index) => {
    const label = labels[index];
    const start = label === undefined ? -1 : anchor(prompt, label, anchored);
    if (label !== undefined && start >= 0)
      file.mention = { start, end: start + label.length, text: label };
  });
  return {
    id,
    text: prompt,
    ...(files.length ? { files } : {}),
    ...(agents.length ? { agents } : {}),
    ...(skills.length ? { skills } : {}),
    commands,
  };
}
function workspaceLabel(cwd: string, path: string): string | undefined {
  const local = relative(cwd, resolve(cwd, path));
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
    return undefined;
  return `@${local.split(sep).join("/")}`;
}
/** First whole-token occurrence of `label` not already anchored to another file. */
function anchor(text: string, label: string, used: Set<number>): number {
  for (let at = text.indexOf(label); at >= 0; at = text.indexOf(label, at + 1)) {
    const after = text.slice(at + label.length, at + label.length + 2);
    if (used.has(at) || /^(?:[\w/-]|\.\w)/.test(after)) continue;
    used.add(at);
    return at;
  }
  return -1;
}
