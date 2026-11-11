/*
 * The light formatting a chat bubble shows (ADR 0127): paragraphs, lists, code blocks, and inside
 * a line bold, inline code and links. Anything else reads as the text it is. Pure, so web and
 * iOS share one reading of a message.
 */

export type SpadeInline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export type SpadeBlock =
  | { kind: "paragraph"; inlines: SpadeInline[] }
  | { kind: "list"; ordered: boolean; items: SpadeInline[][] }
  | { kind: "code"; text: string };

const fence = /^\s*```/;
const bullet = /^\s*[-*•]\s+(.*)$/;
const numbered = /^\s*\d+[.)]\s+(.*)$/;

export function spadeMarkup(text: string): SpadeBlock[] {
  const blocks: SpadeBlock[] = [];
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length)
      blocks.push({ kind: "paragraph", inlines: spadeInlines(paragraph.join("\n")) });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (fence.test(line)) {
      flush();
      const code: string[] = [];
      for (index++; index < lines.length && !fence.test(lines[index] ?? ""); index++)
        code.push(lines[index] ?? "");
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const item = bullet.exec(line) ?? numbered.exec(line);
    if (item) {
      flush();
      const ordered = !bullet.test(line);
      const last = blocks.at(-1);
      const inlines = spadeInlines(item[1] ?? "");
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(inlines);
      else blocks.push({ kind: "list", ordered, items: [inlines] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** `**bold**`, `` `code` ``, `[words](https://…)` and bare https links; the rest is text. */
const inline =
  /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

export function spadeInlines(text: string): SpadeInline[] {
  const out: SpadeInline[] = [];
  let at = 0;
  for (const match of text.matchAll(inline)) {
    const start = match.index;
    if (start > at) out.push({ kind: "text", text: text.slice(at, start) });
    const [whole, bold, code, label, href, bare] = match;
    if (bold !== undefined) out.push({ kind: "bold", text: bold });
    else if (code !== undefined) out.push({ kind: "code", text: code });
    else if (label !== undefined && href !== undefined)
      out.push({ kind: "link", text: label, href });
    else if (bare !== undefined) out.push({ kind: "link", text: bare, href: bare });
    at = start + whole.length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}
