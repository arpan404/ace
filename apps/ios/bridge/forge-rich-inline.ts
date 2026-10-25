import { gemoji } from "gemoji";
import {
  decodeEntities as decode,
  footnoteDefinition,
  htmlPieces,
  htmlTree,
  safeImage,
  safeLink,
  textSegments,
  type HtmlNode,
  type RunEntry,
} from "@ace/ui-core/forge-rich";
import type { Token, Tokens } from "marked";

/*
 * The inline half of forge text for the phone (ADR 0096): marked's inline tokens and the
 * allowed inline HTML among them as styled runs the phone draws as one attributed string, with
 * GitHub's emoji, mentions, references, commit SHAs and footnote markers read from plain text by
 * the web's rules (`textSegments`). Images inside a line come back apart, to draw as blocks.
 */

/** One run of text and how it is styled; absent flags are off. */
export interface Run {
  text: string;
  b?: true;
  i?: true;
  s?: true;
  code?: true;
  kbd?: true;
  sup?: true;
  sub?: true;
  u?: true;
  mark?: true;
  link?: string;
}
type Style = Omit<Run, "text">;

/** An image met inside a line: drawn as its own block after the line it was in. */
export interface InlineImage {
  src: string;
  dark: string | null;
  alt: string;
  width: number | null;
  height: number | null;
}

export interface RichContext {
  host: string;
  /** The repository's address, for `#123` and commit links. */
  repositoryUrl: string;
  footnotes: ReadonlyMap<string, number>;
}

let emojiNames: ReadonlyMap<string, string> | undefined;
/** GitHub's shortcodes (`:tada:`), from the list GitHub publishes, read once. */
function emoji(): ReadonlyMap<string, string> {
  if (!emojiNames) {
    const names = new Map<string, string>();
    for (const entry of gemoji) for (const name of entry.names) names.set(name, entry.emoji);
    emojiNames = names;
  }
  return emojiNames;
}

/** Runs and images gathered from one line of inline content. */
export class Inline {
  readonly runs: Run[] = [];
  readonly images: InlineImage[] = [];
  readonly context: RichContext;
  constructor(context: RichContext) {
    this.context = context;
  }

  /** Plain text, read for GitHub's links and emoji unless it is code. */
  text(text: string, style: Style): void {
    if (!text) return;
    if (style.code || style.kbd) return this.#push({ text, ...style });
    const { repositoryUrl } = this.context;
    for (const segment of textSegments(text, {
      emoji: emoji(),
      footnotes: this.context.footnotes,
    })) {
      switch (segment.kind) {
        case "text":
          this.#push({ text: segment.text, ...style });
          break;
        case "emoji":
          this.#push({ text: segment.emoji, ...style });
          break;
        case "image-emoji":
          this.#push({ text: `:${segment.code}:`, ...style });
          break;
        case "mention":
          this.#push({
            text: segment.text,
            ...style,
            b: true,
            link: segment.team
              ? `https://${this.context.host}/orgs/${segment.login}/teams/${segment.team}`
              : `https://${this.context.host}/${segment.login}`,
          });
          break;
        case "reference":
          this.#push({
            text: segment.text,
            ...style,
            link: `${repositoryUrl}/issues/${segment.number}`,
          });
          break;
        case "cross-reference":
          this.#push({
            text: segment.text,
            ...style,
            link: `https://${this.context.host}/${segment.owner}/${segment.repo}/issues/${segment.number}`,
          });
          break;
        case "commit":
          this.#push({
            text: segment.text,
            ...style,
            code: true,
            link:
              segment.owner && segment.repo
                ? `https://${this.context.host}/${segment.owner}/${segment.repo}/commit/${segment.sha}`
                : `${repositoryUrl}/commit/${segment.sha}`,
          });
          break;
        case "footnote":
          this.#push({ text: String(segment.number), ...style, sup: true });
          break;
      }
    }
  }

  /** Marked's inline tokens, with any inline HTML among them read as one tree. */
  tokens(tokens: readonly Token[], style: Style): void {
    if (tokens.some((token) => token.type === "html")) {
      const run: RunEntry[] = tokens.map((token, index) =>
        token.type === "html"
          ? { kind: "html", pieces: htmlPieces(token.text) }
          : { kind: "token", index },
      );
      this.nodes(htmlTree(run, this.context.host), tokens, style);
      return;
    }
    for (const token of tokens) this.token(token, style);
  }

  token(token: Token, style: Style): void {
    switch (token.type) {
      case "text":
      case "escape": {
        const text = token as Tokens.Text;
        if (text.tokens?.length) this.tokens(text.tokens, style);
        else this.text(decode(text.text), style);
        return;
      }
      case "strong":
        return this.tokens((token as Tokens.Strong).tokens, { ...style, b: true });
      case "em":
        return this.tokens((token as Tokens.Em).tokens, { ...style, i: true });
      case "del":
        return this.tokens((token as Tokens.Del).tokens, { ...style, s: true });
      case "codespan":
        return this.#push({ text: decode((token as Tokens.Codespan).text), ...style, code: true });
      case "br":
        return this.#push({ text: "\n", ...style });
      case "link": {
        const link = token as Tokens.Link;
        const href = safeLink(link.href, this.context.host);
        return this.tokens(link.tokens, href ? { ...style, link: href } : style);
      }
      case "image": {
        const image = token as Tokens.Image;
        const src = safeImage(image.href, this.context.host);
        if (src) this.images.push({ src, dark: null, alt: image.text, width: null, height: null });
        else this.text(image.text, style);
        return;
      }
      case "checkbox":
        return;
      default:
        // A token kind the phone doesn't know shows as its source text, never dropped.
        this.text(token.raw, style);
    }
  }

  /** An inline HTML tree: allowed tags style their children; tokens are drawn in place. */
  nodes(nodes: readonly HtmlNode[], tokens: readonly Token[], style: Style): void {
    for (const node of nodes) {
      if (node.kind === "text") this.text(node.text, style);
      else if (node.kind === "token") {
        const token = tokens[node.index];
        if (token) this.token(token, style);
      } else this.element(node, tokens, style);
    }
  }

  element(
    node: Extract<HtmlNode, { kind: "element" }>,
    tokens: readonly Token[],
    style: Style,
  ): void {
    const children = (next: Style) => this.nodes(node.children, tokens, next);
    switch (node.tag) {
      case "b":
      case "strong":
        return children({ ...style, b: true });
      case "i":
      case "em":
      case "cite":
      case "dfn":
      case "var":
        return children({ ...style, i: true });
      case "s":
      case "del":
      case "strike":
        return children({ ...style, s: true });
      case "code":
      case "tt":
      case "samp":
        return children({ ...style, code: true });
      case "kbd":
        return children({ ...style, kbd: true });
      case "sup":
        return children({ ...style, sup: true });
      case "sub":
        return children({ ...style, sub: true });
      case "ins":
      case "u":
        return children({ ...style, u: true });
      case "mark":
        return children({ ...style, mark: true });
      case "a":
        return children(node.attrs.href ? { ...style, link: node.attrs.href } : style);
      case "br":
        return this.#push({ text: "\n", ...style });
      case "img":
        if (node.attrs.src)
          this.images.push({
            src: node.attrs.src,
            dark: null,
            alt: node.attrs.alt ?? "",
            width: pixels(node.attrs.width),
            height: pixels(node.attrs.height),
          });
        return;
      default:
        return children(style);
    }
  }

  /** A footnote definition's own text, without its `[^label]:`. */
  definition(tokens: readonly Token[]): void {
    const [lead, ...rest] = tokens;
    if (lead?.type === "text") this.text(decode(lead.raw.replace(footnoteDefinition, "")), {});
    else if (lead) this.token(lead, {});
    this.tokens(rest, {});
  }

  #push(run: Run): void {
    const last = this.runs.at(-1);
    if (last && sameStyle(last, run)) last.text += run.text;
    else this.runs.push(run);
  }
}

const styleKeys = ["b", "i", "s", "code", "kbd", "sup", "sub", "u", "mark", "link"] as const;
const sameStyle = (a: Run, b: Run) => styleKeys.every((key) => a[key] === b[key]);

/** A width or height in pixels; a percentage or nothing reads as none. */
export function pixels(value: string | undefined): number | null {
  if (!value || value.endsWith("%")) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 4096) : null;
}
