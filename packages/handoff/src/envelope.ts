import { PortableHandoff } from "@ace/protocol";

/*
 * The context block ace puts in front of the first message after a handoff. Providers can echo
 * that message back with the block still attached; these helpers find and remove only ace's own
 * leading block, so the person's words show as they typed them. Pure.
 */

export const handoffTag = "ace_context_handoff";
const open = new RegExp(
  `^<${handoffTag} source_thread="[^"\\n]{1,256}" through_seq="\\d{1,16}">\\n`,
);
const close = `\n</${handoffTag}>`;
const maxEnvelope = 512 * 1024;

/** Text inside the block can never end it early. */
export function escapeHandoffText(text: string): string {
  return text.replaceAll(`</${handoffTag}`, `<\\/${handoffTag}`);
}

/**
 * `text` without ace's leading handoff block, or undefined when it doesn't start with one.
 * Reads both the plain-text block and the JSON manifest older builds sent.
 */
export function withoutHandoffEnvelope(text: string): string | undefined {
  const trimmed = text.trimStart();
  if (trimmed.length > maxEnvelope + 64 * 1024) return undefined;
  if (open.test(trimmed)) {
    const end = trimmed.indexOf(close);
    if (end < 0 || end > maxEnvelope) return undefined;
    return trimmed.slice(end + close.length).replace(/^(?:\r?\n)+/, "");
  }
  return withoutJsonManifest(trimmed);
}

/** The version 1 envelope: the manifest itself as JSON, validated before it is removed. */
function withoutJsonManifest(text: string): string | undefined {
  if (!/^\{\s*"version"\s*:\s*1\s*,/.test(text) || text.length > maxEnvelope) return undefined;
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
        if (!PortableHandoff.safeParse(JSON.parse(text.slice(0, i + 1))).success) return undefined;
        return text.slice(i + 1).replace(/^(?:\r?\n)+/, "");
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
