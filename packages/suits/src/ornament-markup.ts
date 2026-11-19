/*
 * A small tolerant tokenizer for ornament files (SVG or HTML fragments): open and close tags with
 * their attributes, text, and the line each starts on. Comments, CDATA, doctypes and processing
 * instructions come back as `skip`. The contents of `<script>`, `<style>` and the other raw-text
 * elements are one `text` token, so markup inside them never opens a tag. Pure.
 */

export interface OrnamentAttribute {
  name: string;
  /** Entity references decoded. */
  value: string;
}

export type OrnamentToken =
  | {
      kind: "open";
      name: string;
      attributes: OrnamentAttribute[];
      selfClosing: boolean;
      line: number;
    }
  | { kind: "close"; name: string; line: number }
  | { kind: "text"; text: string; line: number }
  | { kind: "skip"; what: string; line: number };

const rawText = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noscript"]);

const named: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** `&amp;`, `&#106;`, `&#x6a;` and a few names decoded; anything else left as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    }
    return named[body.toLowerCase()] ?? whole;
  });
}

export function tokenizeOrnament(source: string): OrnamentToken[] {
  const tokens: OrnamentToken[] = [];
  let index = 0;
  let line = 1;
  const advance = (to: number) => {
    for (let at = index; at < to; at++) if (source.charCodeAt(at) === 10) line += 1;
    index = to;
  };
  const skipPast = (end: string, what: string) => {
    const start = line;
    const found = source.indexOf(end, index);
    advance(found === -1 ? source.length : found + end.length);
    tokens.push({ kind: "skip", what, line: start });
  };
  while (index < source.length) {
    const lt = source.indexOf("<", index);
    if (lt === -1) {
      tokens.push({ kind: "text", text: source.slice(index), line });
      advance(source.length);
      break;
    }
    if (lt > index) {
      tokens.push({ kind: "text", text: source.slice(index, lt), line });
      advance(lt);
    }
    if (source.startsWith("<!--", index)) skipPast("-->", "comment");
    else if (source.startsWith("<![CDATA[", index)) skipPast("]]>", "CDATA section");
    else if (source.startsWith("<!", index)) skipPast(">", "declaration");
    else if (source.startsWith("<?", index)) skipPast(">", "processing instruction");
    else if (source[index + 1] === "/") {
      const match = /^<\/\s*([A-Za-z][\w:.-]*)[^>]*>?/.exec(source.slice(index));
      if (!match?.[1]) {
        tokens.push({ kind: "text", text: "<", line });
        advance(index + 1);
        continue;
      }
      tokens.push({ kind: "close", name: match[1], line });
      advance(index + match[0].length);
    } else {
      const open = readOpenTag(source, index);
      if (!open) {
        tokens.push({ kind: "text", text: "<", line });
        advance(index + 1);
        continue;
      }
      const start = line;
      tokens.push({ kind: "open", ...open.tag, line: start });
      advance(open.end);
      const lower = open.tag.name.toLowerCase();
      if (rawText.has(lower) && !open.tag.selfClosing) {
        // Everything up to its close tag is text, whatever it looks like.
        const close = new RegExp(`</\\s*${lower}\\b`, "i").exec(source.slice(index));
        const end = close ? index + close.index : source.length;
        tokens.push({ kind: "text", text: source.slice(index, end), line });
        advance(end);
      }
    }
  }
  return tokens;
}

function readOpenTag(
  source: string,
  start: number,
):
  | { tag: { name: string; attributes: OrnamentAttribute[]; selfClosing: boolean }; end: number }
  | undefined {
  const head = /^<([A-Za-z][\w:.-]*)/.exec(source.slice(start, start + 200));
  if (!head?.[1]) return undefined;
  const attributes: OrnamentAttribute[] = [];
  let at = start + head[0].length;
  const attribute = /\s*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
  for (;;) {
    while (at < source.length && /\s/.test(source[at] ?? "")) at += 1;
    if (at >= source.length)
      return { tag: { name: head[1], attributes, selfClosing: false }, end: at };
    if (source[at] === ">")
      return { tag: { name: head[1], attributes, selfClosing: false }, end: at + 1 };
    if (source.startsWith("/>", at))
      return { tag: { name: head[1], attributes, selfClosing: true }, end: at + 2 };
    if (source[at] === "/") {
      at += 1;
      continue;
    }
    attribute.lastIndex = at;
    const match = attribute.exec(source);
    if (!match?.[1]) {
      at += 1;
      continue;
    }
    attributes.push({
      name: match[1],
      value: decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""),
    });
    at = attribute.lastIndex;
  }
}
