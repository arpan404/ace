import type { ContentPart } from "@ace/protocol";
/** Prefix-only harnesses receive one native command per admission, with the complete message as context. */
export function nativeCommandInputs(input: readonly ContentPart[]): ContentPart[][] {
  const commands: string[] = [];
  const context: ContentPart[] = [];
  for (const part of input) {
    if (part.type !== "mention") {
      context.push(part.type === "text" ? { ...part } : part);
      continue;
    }
    if (part.invocation?.type !== "slash") throw new Error("Unresolved command mention");
    commands.push(`/${part.invocation.name}${part.arguments ? ` ${part.arguments}` : ""}`);
    const text = `[${part.name}]`;
    const last = context.at(-1);
    if (last?.type === "text") last.text += text;
    else context.push({ type: "text", text });
  }
  if (!commands.length) return [[...input]];
  return commands.map((command) => {
    const parts: ContentPart[] = [{ type: "text", text: `${command}\n\nMessage context:\n` }];
    parts.push(...context);
    return parts;
  });
}
