// oxlint-disable react/no-array-index-key -- lexer tokens have no identity; position is it.
import type { MarkedToken, Token } from "marked";
import { memo, type ReactNode } from "react";
import { codeSpanClass } from "@/components/inline-markdown.tsx";
import type { MarkdownBlock } from "./blocks.ts";
import { CodeBlock } from "./code-block.tsx";
import { useMarkdown } from "./use-markdown.ts";

/*
 * Agent prose rendered from marked's lexer tokens into React elements. No HTML string is ever
 * injected: raw HTML in a message shows as text, and only http(s) and mailto links are live.
 */

const known = new Set<string>([
  "blockquote",
  "br",
  "checkbox",
  "code",
  "codespan",
  "def",
  "del",
  "em",
  "escape",
  "heading",
  "hr",
  "html",
  "image",
  "link",
  "list",
  "list_item",
  "paragraph",
  "space",
  "strong",
  "table",
  "text",
]);
function isKnown(token: Token): token is MarkedToken {
  return known.has(token.type);
}

function safeHref(href: string): string | undefined {
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function inline(tokens: readonly Token[] | undefined): ReactNode {
  return tokens?.map((token, index) => <Inline key={index} token={token} />);
}

function Inline(props: { token: Token }): ReactNode {
  const token = props.token;
  if (!isKnown(token)) return token.raw;
  switch (token.type) {
    case "strong":
      return <strong className="font-medium">{inline(token.tokens)}</strong>;
    case "em":
      return <em>{inline(token.tokens)}</em>;
    case "del":
      return <del className="text-muted-foreground">{inline(token.tokens)}</del>;
    case "codespan":
      return <code className={codeSpanClass}>{token.text}</code>;
    case "br":
      return <br />;
    case "link": {
      const href = safeHref(token.href);
      if (!href) return inline(token.tokens);
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-link underline decoration-ring/40 underline-offset-[3px] hover:decoration-current"
        >
          {inline(token.tokens)}
        </a>
      );
    }
    case "image": {
      const href = safeHref(token.href);
      return href ? (
        <a href={href} target="_blank" rel="noreferrer noopener" className="underline">
          {token.text || href}
        </a>
      ) : (
        token.text
      );
    }
    case "text":
      return token.tokens ? inline(token.tokens) : token.text;
    case "escape":
      return token.text;
    case "html":
      return token.text;
    case "checkbox":
      return (
        <input
          type="checkbox"
          checked={token.checked}
          readOnly
          aria-label={token.checked ? "Done" : "Not done"}
          className="mr-1.5 align-[-1px]"
        />
      );
    default:
      return "raw" in token ? token.raw : null;
  }
}

const headingClass = [
  "",
  "mt-5 mb-2 text-[1.2em] font-semibold tracking-title",
  "mt-5 mb-2 text-[1.1em] font-semibold",
  "mt-4 mb-1.5 text-[1em] font-semibold",
];

function Block(props: { token: Token; code?: MarkdownBlock["code"] }): ReactNode {
  const token = props.token;
  if (!isKnown(token)) return <p>{token.raw}</p>;
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "paragraph":
      return <p className="[&+*]:mt-3">{inline(token.tokens)}</p>;
    case "heading": {
      const Tag = `h${Math.min(6, Math.max(3, token.depth + 2))}` as "h3" | "h4" | "h5" | "h6";
      return (
        <Tag className={headingClass[Math.min(3, token.depth)] ?? headingClass[3]}>
          {inline(token.tokens)}
        </Tag>
      );
    }
    case "code":
      return (
        <CodeBlock
          code={token.text}
          lang={token.lang}
          {...(props.code ? { tokens: props.code } : {})}
        />
      );
    case "blockquote":
      return (
        <blockquote className="my-3 border-l-2 pl-3 text-muted-foreground">
          <Blocks tokens={token.tokens} />
        </blockquote>
      );
    case "hr":
      return <hr className="my-5 border-0 border-t" />;
    case "list": {
      const items = token.items.map((item, index) => (
        <li key={index} className={item.task ? "list-none [&+li]:mt-1" : "pl-0.5 [&+li]:mt-1"}>
          {/* Task items carry their own checkbox token. */}
          {item.loose ? <Blocks tokens={item.tokens} /> : <Tight tokens={item.tokens} />}
        </li>
      ));
      return token.ordered ? (
        <ol
          start={token.start === "" ? undefined : token.start}
          className="my-2 list-decimal pl-[22px] marker:text-muted-foreground"
        >
          {items}
        </ol>
      ) : (
        <ul className="my-2 list-disc pl-[22px] marker:text-subtle-foreground">{items}</ul>
      );
    }
    case "table":
      return (
        <div className="my-3 overflow-x-auto">
          <table className="w-full border-collapse text-[0.9em]">
            <thead>
              <tr>
                {token.header.map((cell, index) => (
                  <th
                    key={index}
                    style={{ textAlign: cell.align ?? undefined }}
                    className="border-b px-2 py-1.5 text-left font-medium"
                  >
                    {inline(cell.tokens)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {token.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td
                      key={index}
                      style={{ textAlign: cell.align ?? undefined }}
                      className="border-b px-2 py-1.5"
                    >
                      {inline(cell.tokens)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "html":
      return <p className="whitespace-pre-wrap">{token.text}</p>;
    case "text":
      return <p>{token.tokens ? inline(token.tokens) : token.text}</p>;
    default:
      return <Inline token={token} />;
  }
}

/** List items without blank lines between them hold bare inline text, not paragraphs. */
function Tight(props: { tokens: readonly Token[] }) {
  return props.tokens.map((token, index) =>
    token.type === "text" ? (
      <Inline key={index} token={token} />
    ) : (
      <Block key={index} token={token} />
    ),
  );
}

function Blocks(props: { tokens: readonly Token[] }) {
  return props.tokens.map((token, index) => <Block key={index} token={token} />);
}

/** One top-level block. Its object is shared while its source is unchanged, so it skips. */
const TopBlock = memo(function TopBlock(props: { block: MarkdownBlock }) {
  return (
    <Block token={props.block.token} {...(props.block.code ? { code: props.block.code } : {})} />
  );
});

/**
 * Transcript prose (15.5/1.6), lexed and highlighted in the markdown worker. A streaming
 * message re-renders only its last block; until its first document is ready it shows as text.
 */
export const Markdown = memo(function Markdown(props: { text: string; className?: string }) {
  const doc = useMarkdown(props.text);
  if (!doc) return <p className={`whitespace-pre-wrap ${props.className ?? ""}`}>{props.text}</p>;
  return (
    <div className={props.className}>
      {doc.blocks.map((block) => (
        <TopBlock key={block.key} block={block} />
      ))}
    </div>
  );
});
