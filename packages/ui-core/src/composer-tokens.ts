import type { CatalogMention, ContentPart, Mention, ThreadRefContextItem } from "@ace/protocol";

/** Offsets use the draft's plain text, including each reference's visible name. */
export interface ComposerToken {
  start: number;
  end: number;
  label: string;
  catalog?: CatalogMention | undefined;
  file?: Mention | undefined;
  thread?: ThreadRefContextItem | undefined;
}

/** An edit touching a reference removes it; edits around it preserve its position. */
export function editComposerTokens(
  before: string,
  after: string,
  tokens: readonly ComposerToken[],
): readonly ComposerToken[] {
  if (!tokens.length || before === after) return tokens;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length;
  let nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  const delta = nextEnd - end;
  const next = tokens.flatMap((token) => {
    if (token.end <= start) return [token];
    if (token.start >= end)
      return [{ ...token, start: token.start + delta, end: token.end + delta }];
    return [];
  });
  return next.length === tokens.length && next.every((token, index) => token === tokens[index])
    ? tokens
    : next;
}

export function composerInput(text: string, tokens: readonly ComposerToken[]): ContentPart[] {
  const parts: ContentPart[] = [];
  let at = 0;
  for (const token of tokens) {
    if (!token.catalog) continue;
    if (token.start > at) parts.push({ type: "text", text: text.slice(at, token.start) });
    parts.push(token.catalog);
    at = token.end;
  }
  if (at < text.length) parts.push({ type: "text", text: text.slice(at) });
  return parts.length ? parts : [{ type: "text", text: text || "See the attached files." }];
}

/** Recover references when editing a failed send. */
export function tokensFromInput(input: readonly ContentPart[]): {
  text: string;
  tokens: ComposerToken[];
} {
  let text = "";
  const tokens: ComposerToken[] = [];
  for (const part of input) {
    if (part.type === "text") text += part.text;
    if (part.type === "mention") {
      const label = part.name;
      tokens.push({ start: text.length, end: text.length + label.length, label, catalog: part });
      text += label;
    }
  }
  return { text, tokens };
}
