import type { Token, Tokens } from "marked";

/*
 * GitHub markdown's own blocks (ADR 0096), read from the lexer's tokens: alerts (`> [!NOTE]`),
 * footnote definitions, and links GitHub may show as a player. Pure; the web's renderer and the
 * phone's bridge share them.
 */

const alertMarker = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i;

/** A blockquote that opens with `[!NOTE]` (and the like): its kind and its tokens without it. */
export function alertOf(
  token: Tokens.Blockquote,
): { kind: string; tokens: readonly Token[] } | undefined {
  const first = token.tokens[0];
  if (first?.type !== "paragraph" || !("tokens" in first)) return undefined;
  const paragraph = first as Tokens.Paragraph;
  const match = alertMarker.exec(paragraph.raw);
  const kind = match?.[1]?.toUpperCase();
  if (!match || !kind) return undefined;
  // The marker sits at the start of the paragraph's first text token: cut it from there.
  const [lead, ...rest] = paragraph.tokens;
  const inline: Token[] = [...rest];
  if (lead && lead.type === "text") {
    const remaining = lead.raw.replace(alertMarker, "");
    if (remaining)
      inline.unshift({ ...lead, raw: remaining, text: remaining, tokens: undefined } as Token);
  } else if (lead) inline.unshift(lead);
  const remainder = paragraph.raw.replace(alertMarker, "");
  const tokens: Token[] = token.tokens.slice(1);
  if (remainder.trim())
    tokens.unshift({ ...paragraph, raw: remainder, text: remainder, tokens: inline });
  return { kind, tokens };
}

/** A footnote definition's opening, `[^label]:`, and its label. */
export const footnoteDefinition = /^ {0,3}\[\^([^\]\s]{1,64})\]:[ \t]?/;

/** A paragraph or link definition that defines footnote `label`, with the label. */
export function footnoteLabel(token: Token): string | undefined {
  if (token.type !== "paragraph" && token.type !== "def") return undefined;
  return footnoteDefinition.exec(token.raw)?.[1];
}

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const attachment = new RegExp(`^/user-attachments/assets/${uuid}/?$`, "i");
const repositoryAsset = new RegExp(`^/[^/]+/[^/]+/assets/\\d+/${uuid}/?$`, "i");
const videoFile = /\.(mp4|mov|webm)$/i;

/** A link GitHub may show as a player when it stands alone on its line. */
export function mediaLink(href: string, host: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.hostname === host)
    return attachment.test(url.pathname) || repositoryAsset.test(url.pathname);
  return url.hostname.endsWith("githubusercontent.com") && videoFile.test(url.pathname);
}
