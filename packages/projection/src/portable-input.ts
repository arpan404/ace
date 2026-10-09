import { PortableHandoff, type ContentPart } from "@ace/protocol";

/** Remove only ace's validated leading envelope, including echoes joined into one text part. */
export function withoutPortableHandoff(parts: readonly ContentPart[]): ContentPart[] {
  const first = parts[0];
  if (first?.type !== "text") return [...parts];
  const text = first.text.trimStart();
  if (!/^\{\s*"version"\s*:\s*1\s*,/.test(text) || text.length > 512 * 1024) return [...parts];
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try {
        if (!PortableHandoff.safeParse(JSON.parse(text.slice(0, i + 1))).success) break;
        const rest = text.slice(i + 1).replace(/^(?:\r?\n)+/, "");
        return [...(rest ? [{ type: "text" as const, text: rest }] : []), ...parts.slice(1)];
      } catch {
        break;
      }
    }
  }
  return [...parts];
}
