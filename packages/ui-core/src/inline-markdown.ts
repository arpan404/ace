/** A run of short inline text: plain, `code`, **strong** or *emphasis*. */
export type InlineSpan =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string };

// Code first so markers inside backticks stay literal; then **strong**, then *em* or _em_.
const pattern =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<!\w)_([^_\n]+)_(?!\w)/gu;

/**
 * Splits short text (comments, questions, labels) into inline spans. Only code, strong and
 * emphasis are recognised; anything else, unmatched markers included, stays as text.
 */
export function inlineSpans(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let last = 0;
  const push = (span: InlineSpan) => {
    const previous = spans.at(-1);
    if (span.kind === "text" && previous?.kind === "text") previous.text += span.text;
    else if (span.text) spans.push(span);
  };
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    push({ kind: "text", text: text.slice(last, at) });
    const [, code, strong, star, underscore] = match;
    if (code !== undefined) push({ kind: "code", text: code });
    else if (strong !== undefined) push({ kind: "strong", text: strong });
    else push({ kind: "em", text: star ?? underscore ?? "" });
    last = at + match[0].length;
  }
  push({ kind: "text", text: text.slice(last) });
  return spans;
}
