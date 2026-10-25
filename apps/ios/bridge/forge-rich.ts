import {
  alertOf,
  footnoteDefinition,
  footnoteLabel,
  footnoteNumbers,
  htmlPieces,
  htmlTree,
  mediaLink,
  taskMarks,
  type HtmlNode,
  type RunEntry,
} from "@ace/ui-core/forge-rich";
import { Lexer, type Token, type Tokens } from "marked";
import { imageOf, picture, plain, tableOf } from "./forge-rich-html.ts";
import { Inline, type InlineImage, type RichContext, type Run } from "./forge-rich-inline.ts";

/*
 * Pull request and issue text as the phone draws it natively (ADR 0096), decided here by the
 * web's rules: GitHub's markdown and its HTML subset (through the web's allowlist), alerts, task
 * boxes placed in the source so ticking one rewrites only its mark, footnotes, images and videos
 * (fetched later through the daemon), light and dark pictures and mermaid diagrams. Anything the
 * allowlist refuses shows as its source text. Pure.
 */

export type RichBlock =
  | { k: "p"; runs: Run[]; align: string | null }
  | { k: "h"; level: number; runs: Run[] }
  | { k: "code"; lang: string; text: string }
  | { k: "mermaid"; text: string }
  | { k: "quote"; blocks: RichBlock[] }
  | { k: "alert"; kind: string; blocks: RichBlock[] }
  | { k: "list"; ordered: boolean; start: number; items: RichItem[] }
  | { k: "table"; head: Run[][]; rows: Run[][][] }
  | { k: "rule" }
  | ({ k: "image" } & InlineImage)
  | { k: "video"; src: string }
  /** A link alone on its line that GitHub may show as a player; a link when it isn't media. */
  | { k: "media"; url: string; runs: Run[] }
  | { k: "details"; summary: Run[]; open: boolean; blocks: RichBlock[] }
  | { k: "footnotes"; notes: { number: number; runs: Run[] }[] };

export interface RichItem {
  /** A task box: whether it is ticked, and where its mark sits in the source (null: unplaced). */
  task: { checked: boolean; offset: number | null } | null;
  blocks: RichBlock[];
}

/** Elements that start a block of their own inside HTML. */
const blockTags = new Set([
  "p",
  "div",
  "center",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "details",
  "pre",
  "picture",
  "video",
  "figure",
  "hr",
  "dl",
  "dt",
  "dd",
  "summary",
  "figcaption",
]);

class Builder {
  readonly context: RichContext;
  readonly marks: Map<Token, { offset: number }>;
  constructor(context: RichContext, marks: Map<Token, { offset: number }>) {
    this.context = context;
    this.marks = marks;
  }

  blocks(tokens: readonly Token[]): RichBlock[] {
    // A run holding raw HTML is read as one tree: an element may span the blocks between.
    if (tokens.some((token) => token.type === "html")) {
      const run: RunEntry[] = tokens.map((token, index) =>
        token.type === "html"
          ? { kind: "html", pieces: htmlPieces(token.text) }
          : { kind: "token", index },
      );
      return this.nodes(htmlTree(run, this.context.host), tokens);
    }
    return tokens.flatMap((token) => this.block(token));
  }

  block(token: Token): RichBlock[] {
    switch (token.type) {
      case "space":
      case "def":
        return [];
      case "paragraph": {
        const paragraph = token as Tokens.Paragraph;
        const label = footnoteLabel(token);
        // Drawn with the footnotes, after the last block.
        if (label !== undefined && this.context.footnotes.has(label)) return [];
        const [only, ...rest] = paragraph.tokens;
        if (!rest.length && only?.type === "link") {
          const link = only as Tokens.Link;
          if (link.text === link.href && mediaLink(link.href, this.context.host))
            return [{ k: "media", url: link.href, runs: [{ text: link.href, link: link.href }] }];
        }
        return this.line(paragraph.tokens, null);
      }
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens ? this.line(text.tokens, null) : this.line([token], null);
      }
      case "heading": {
        const heading = token as Tokens.Heading;
        const inline = new Inline(this.context);
        inline.tokens(heading.tokens, {});
        return [{ k: "h", level: heading.depth, runs: inline.runs }, ...images(inline)];
      }
      case "code": {
        const code = token as Tokens.Code;
        const lang = code.lang?.trim().toLowerCase() ?? "";
        return [
          lang === "mermaid"
            ? { k: "mermaid", text: code.text }
            : { k: "code", lang, text: code.text },
        ];
      }
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        const alert = alertOf(quote);
        return alert
          ? [{ k: "alert", kind: alert.kind.toLowerCase(), blocks: this.blocks(alert.tokens) }]
          : [{ k: "quote", blocks: this.blocks(quote.tokens) }];
      }
      case "list": {
        const list = token as Tokens.List;
        return [
          {
            k: "list",
            ordered: list.ordered,
            start: typeof list.start === "number" ? list.start : 1,
            items: list.items.map((item) => this.item(item)),
          },
        ];
      }
      case "table": {
        const table = token as Tokens.Table;
        const cell = (tokens: readonly Token[]) => {
          const inline = new Inline(this.context);
          inline.tokens(tokens, {});
          return inline.runs;
        };
        return [
          {
            k: "table",
            head: table.header.map((head) => cell(head.tokens)),
            rows: table.rows.slice(0, 200).map((row) => row.map((each) => cell(each.tokens))),
          },
        ];
      }
      case "hr":
        return [{ k: "rule" }];
      default:
        return this.line([token], null);
    }
  }

  item(item: Tokens.ListItem): RichItem {
    const checkbox = item.tokens.find((child) => child.type === "checkbox") as
      | Tokens.Checkbox
      | undefined;
    const nested = item.tokens[0];
    const loose =
      nested && "tokens" in nested && Array.isArray(nested.tokens)
        ? (nested.tokens.find((child: Token) => child.type === "checkbox") as
            | Tokens.Checkbox
            | undefined)
        : undefined;
    const box = checkbox ?? loose;
    return {
      task:
        item.task || box
          ? {
              checked: box?.checked ?? item.checked ?? false,
              offset: box ? (this.marks.get(box)?.offset ?? null) : null,
            }
          : null,
      blocks: this.blocks(item.tokens.filter((child) => child.type !== "checkbox")),
    };
  }

  /** One line of inline tokens as a paragraph, then the images it held. */
  line(tokens: readonly Token[], align: string | null): RichBlock[] {
    const inline = new Inline(this.context);
    inline.tokens(tokens, {});
    const text = inline.runs.some((run) => run.text.trim() !== "");
    return [
      ...(text ? [{ k: "p" as const, runs: trimmed(inline.runs), align }] : []),
      ...images(inline),
    ];
  }

  /** An HTML tree among block tokens: inline content gathers into paragraphs between blocks. */
  nodes(
    nodes: readonly HtmlNode[],
    tokens: readonly Token[],
    align: string | null = null,
  ): RichBlock[] {
    const out: RichBlock[] = [];
    let pending: Inline | undefined;
    const flush = () => {
      if (!pending) return;
      if (pending.runs.some((run) => run.text.trim() !== ""))
        out.push({ k: "p", runs: trimmed(pending.runs), align });
      out.push(...images(pending));
      pending = undefined;
    };
    const inline = () => (pending ??= new Inline(this.context));
    for (const node of nodes) {
      if (node.kind === "text") {
        if (node.text.trim() || pending) inline().text(node.text, {});
      } else if (node.kind === "token") {
        const token = tokens[node.index];
        if (!token) continue;
        if (isInline(token)) inline().token(token, {});
        else {
          flush();
          out.push(...this.block(token));
        }
      } else if (blockTags.has(node.tag) || node.tag === "img") {
        if (node.tag === "img" && pending) {
          inline().element(node, tokens, {});
          continue;
        }
        flush();
        out.push(...this.element(node, tokens));
      } else inline().element(node, tokens, {});
    }
    flush();
    return out;
  }

  element(node: Extract<HtmlNode, { kind: "element" }>, tokens: readonly Token[]): RichBlock[] {
    const align = node.attrs.align ?? null;
    const runsOf = (children: readonly HtmlNode[]) => {
      const inline = new Inline(this.context);
      inline.nodes(children, tokens, {});
      return { runs: trimmed(inline.runs), images: images(inline) };
    };
    switch (node.tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const { runs, images: held } = runsOf(node.children);
        return [{ k: "h", level: Number(node.tag[1]), runs }, ...held];
      }
      case "blockquote":
        return [{ k: "quote", blocks: this.nodes(node.children, tokens) }];
      case "ul":
      case "ol":
        return [
          {
            k: "list",
            ordered: node.tag === "ol",
            start: Number(node.attrs.start ?? 1) || 1,
            items: node.children
              .filter((child) => child.kind !== "text" || child.text.trim())
              .map((child) => ({
                task: null,
                blocks:
                  child.kind === "element" && child.tag === "li"
                    ? this.nodes(child.children, tokens)
                    : this.nodes([child], tokens),
              })),
          },
        ];
      case "details": {
        const summary = node.children.find(
          (child) => child.kind === "element" && child.tag === "summary",
        );
        const rest = node.children.filter((child) => child !== summary);
        return [
          {
            k: "details",
            summary:
              summary?.kind === "element" ? runsOf(summary.children).runs : [{ text: "Details" }],
            open: "open" in node.attrs,
            blocks: this.nodes(rest, tokens),
          },
        ];
      }
      case "pre":
        return [{ k: "code", lang: "", text: plain(node.children) }];
      case "hr":
        return [{ k: "rule" }];
      case "picture":
        return picture(node);
      case "video":
        return node.attrs.src ? [{ k: "video", src: node.attrs.src }] : [];
      case "img":
        return node.attrs.src ? [{ k: "image", ...imageOf(node.attrs) }] : [];
      case "table":
        return [tableOf(node, (children) => runsOf(children).runs)];
      default:
        // p, div, center, figure, dl and the like: their children, aligned as asked.
        return this.nodes(node.children, tokens, align);
    }
  }
}

const inlineTypes = new Set([
  "text",
  "strong",
  "em",
  "del",
  "codespan",
  "br",
  "link",
  "image",
  "escape",
]);
const isInline = (token: Token) => inlineTypes.has(token.type);

function images(inline: Inline): RichBlock[] {
  return inline.images.map((image) => ({ k: "image" as const, ...image }));
}

/** Runs without the blank lines HTML leaves at either end. */
function trimmed(runs: Run[]): Run[] {
  const out = runs.map((run) => ({ ...run }));
  const first = out[0];
  if (first) first.text = first.text.replace(/^\s+/, "");
  const last = out.at(-1);
  if (last) last.text = last.text.replace(/\s+$/, "");
  return out.filter((run) => run.text !== "");
}

/** The footnotes a document defines, numbered in order, after its last block. */
function footnotes(tokens: readonly Token[], context: RichContext): RichBlock[] {
  const notes = tokens.flatMap((token) => {
    const label = footnoteLabel(token);
    const number = label === undefined ? undefined : context.footnotes.get(label);
    if (number === undefined) return [];
    const inline = new Inline(context);
    if (token.type === "paragraph") inline.definition((token as Tokens.Paragraph).tokens);
    else inline.text(token.raw.replace(footnoteDefinition, "").trim(), {});
    return [{ number, runs: inline.runs }];
  });
  return notes.length ? [{ k: "footnotes", notes }] : [];
}

/** GitHub text as native blocks: `host` is the forge's, `repositoryUrl` its repository's page. */
export function richBlocks(source: string, host: string, repositoryUrl: string): RichBlock[] {
  const tokens = new Lexer({ gfm: true }).lex(source);
  const context: RichContext = { host, repositoryUrl, footnotes: footnoteNumbers(source) };
  const marks = taskMarks(source, tokens);
  const builder = new Builder(context, marks);
  return [...builder.blocks(tokens), ...footnotes(tokens, context)];
}

/** GitHub text of `repository` as native blocks. */
export function repositoryBlocks(
  source: string,
  repository: { host: string; owner: string; name: string },
): RichBlock[] {
  return richBlocks(
    source,
    repository.host,
    `https://${repository.host}/${repository.owner}/${repository.name}`,
  );
}
