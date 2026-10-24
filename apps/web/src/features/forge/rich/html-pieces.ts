import { Tokenizer, type Token } from "parse5";

/*
 * Raw HTML from forge text as a flat run of pieces (ADR 0096): start and end tags with their
 * attributes, text with its character references decoded, and comments. Tokenized to the HTML
 * standard by parse5, but never parsed into a document: an element opened in one markdown block
 * may close in another, so the tree is built later across blocks (`html-tree.ts`). Nothing here
 * decides what is allowed.
 */

export type HtmlPiece =
  | {
      kind: "open";
      tag: string;
      attrs: ReadonlyMap<string, string>;
      selfClosing: boolean;
      /** The tag as written, shown as text when it isn't allowed. */
      raw: string;
    }
  | { kind: "close"; tag: string; raw: string }
  | { kind: "text"; text: string }
  | { kind: "comment" };

const rawOf = (source: string, token: { location: Token.Location | null }) =>
  token.location ? source.slice(token.location.startOffset, token.location.endOffset) : "";

/** `source` as pieces, in order; adjacent text is joined. */
export function htmlPieces(source: string): HtmlPiece[] {
  const pieces: HtmlPiece[] = [];
  const text = (chars: string) => {
    const last = pieces.at(-1);
    if (last?.kind === "text")
      pieces[pieces.length - 1] = { kind: "text", text: last.text + chars };
    else pieces.push({ kind: "text", text: chars });
  };
  const tokenizer = new Tokenizer(
    { sourceCodeLocationInfo: true },
    {
      onStartTag(token) {
        const attrs = new Map<string, string>();
        // The first of a repeated attribute wins, as in a browser.
        for (const attr of token.attrs) if (!attrs.has(attr.name)) attrs.set(attr.name, attr.value);
        pieces.push({
          kind: "open",
          tag: token.tagName,
          attrs,
          selfClosing: token.selfClosing,
          raw: rawOf(source, token),
        });
      },
      onEndTag(token) {
        pieces.push({ kind: "close", tag: token.tagName, raw: rawOf(source, token) });
      },
      onComment() {
        pieces.push({ kind: "comment" });
      },
      onDoctype(token) {
        text(rawOf(source, token));
      },
      onCharacter(token) {
        text(token.chars);
      },
      onWhitespaceCharacter(token) {
        text(token.chars);
      },
      onNullCharacter() {
        text("�");
      },
      onEof() {},
    },
  );
  tokenizer.write(source, true);
  return pieces;
}

/** Text with its character references decoded (`&amp;`, `&copy;`, `&#x1F389;`). */
export function decodeEntities(source: string): string {
  if (!source.includes("&")) return source;
  // `<` would start a tag; it is plain text here, so it is kept apart.
  return source
    .split("<")
    .map((part) =>
      htmlPieces(part)
        .map((piece) => (piece.kind === "text" ? piece.text : ""))
        .join(""),
    )
    .join("<");
}
