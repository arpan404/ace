// oxlint-disable react/no-array-index-key -- lexer tokens have no identity; position is it.
import type { MarkedToken, Token } from "marked";
import { createContext, memo, useContext, useRef, type ReactNode } from "react";
import { codeFileReference, fileTextSpans } from "@ace/ui-core/file-references";
import { ThreadReference, ThreadReferenceScope } from "../thread-reference.tsx";
import { MarkdownImage } from "@/components/attachment-markdown.tsx";
import { CodeText, codeSpanClass } from "@/components/inline-markdown.tsx";
import { FileReferenceLink } from "@/components/file-reference.tsx";
import { PullRequestLink, pullRequestAt } from "@/components/pull-request-link.tsx";
import { cn } from "@/lib/cn.ts";
import { useEdgeFade } from "@/lib/edge-fade.ts";
import type { MarkdownBlock } from "./blocks.ts";
import type { MarkdownLinks } from "./link-options.ts";
import type { MarkdownExtensions } from "./extensions.ts";
import { blockRhythm } from "./rhythm.ts";
import { copyTexSource } from "./math-copy.ts";
import { isMathToken } from "./math-extension.ts";
import { Formula } from "./math.tsx";
import { CodeBlock } from "./code-block.tsx";
import { MarkdownLoading } from "./loading.tsx";
import { useMarkdown } from "./use-markdown.ts";
import { WebLink } from "@/components/web-link.tsx";

/*
 * Agent prose rendered from marked's lexer tokens into React elements. No HTML string is ever
 * injected: raw HTML in a message shows as text, and only http(s) and mailto links are live.
 * Images draw only bytes already on the page (`MarkdownImage`).
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

/**
 * Inline tokens as elements. With extensions (forge text), a run that holds raw HTML is theirs to
 * draw; without (agent prose) the run keeps its plain shape, HTML or not, so a message that
 * gains an HTML token mid-stream never remounts its inline elements.
 */
function inline(
  tokens: readonly Token[] | undefined,
  extensions: MarkdownExtensions | undefined,
): ReactNode {
  if (extensions && tokens?.some((token) => token.type === "html"))
    return <HtmlInlines tokens={tokens} extensions={extensions} />;
  return tokens?.map((token, index) => <Inline key={index} token={token} />);
}

const Links = createContext<MarkdownLinks | undefined>(undefined);
/** What a feature draws instead of the defaults; none for agent prose. */
const Extensions = createContext<MarkdownExtensions | undefined>(undefined);

function HtmlInlines(props: {
  tokens: readonly Token[];
  extensions: MarkdownExtensions;
}): ReactNode {
  return props.extensions.inlines(props.tokens, (index) => {
    const token = props.tokens[index];
    return token ? <Inline key={index} token={token} /> : null;
  });
}

function MarkdownImageToken(props: { href: string; alt: string }): ReactNode {
  const extensions = useContext(Extensions);
  return extensions ? (
    extensions.image(props.href, props.alt)
  ) : (
    <MarkdownImage src={props.href} alt={props.alt} />
  );
}

function Checkbox(props: { token: Extract<MarkedToken, { type: "checkbox" }> }): ReactNode {
  const extensions = useContext(Extensions);
  if (extensions) return extensions.checkbox(props.token);
  return (
    <input
      type="checkbox"
      checked={props.token.checked}
      readOnly
      aria-label={props.token.checked ? "Done" : "Not done"}
      className="mr-1.5 align-[-1px]"
    />
  );
}

/** Inline code; a link into the thread's checkout when it names a file there (settled text). */
function CodeSpan(props: { text: string }): ReactNode {
  const scoped = useContext(ThreadReferenceScope) !== undefined;
  const writing = useContext(Writing);
  const reference = scoped && !writing ? codeFileReference(props.text) : undefined;
  if (!reference)
    return (
      <code className={codeSpanClass}>
        <CodeText text={props.text} />
      </code>
    );
  return <FileReferenceLink text={props.text} reference={reference} code />;
}

/** Plain text, with the file paths it mentions linked once its block has settled. */
function ProseText(props: { text: string }): ReactNode {
  const links = useContext(Links);
  const scoped = useContext(ThreadReferenceScope) !== undefined;
  const writing = useContext(Writing);
  const plain = (text: string) => (links ? links.text(text) : text);
  if (!scoped || writing) return plain(props.text);
  const spans = fileTextSpans(props.text);
  if (spans.length === 1 && spans[0]?.kind === "text") return plain(props.text);
  return spans.map((span, index) =>
    span.kind === "file" ? (
      <FileReferenceLink key={index} text={span.text} reference={span.reference} code={false} />
    ) : (
      <span key={index}>{plain(span.text)}</span>
    ),
  );
}

const linkClass =
  "text-link underline decoration-ring/40 underline-offset-[3px] wrap-break-word hover:decoration-current";

function Inline(props: { token: Token }): ReactNode {
  const links = useContext(Links);
  const extensions = useContext(Extensions);
  const scope = useContext(ThreadReferenceScope);
  const token = props.token;
  if (isMathToken(token)) {
    // An opener still waiting for its closer shows as text; invalid TeX falls
    // back to its source inside `Formula`, never a red error. The key pins one
    // instance to one formula, so a settled formula never re-renders.
    if (token.pending) return token.raw;
    return <Formula key={token.raw} raw={token.raw} tex={token.tex} display={token.display} />;
  }
  if (!isKnown(token)) return token.raw;
  switch (token.type) {
    case "strong":
      return <strong className="font-semibold">{inline(token.tokens, extensions)}</strong>;
    case "em":
      return <em>{inline(token.tokens, extensions)}</em>;
    case "del":
      return <del className="text-muted-foreground">{inline(token.tokens, extensions)}</del>;
    case "codespan":
      return <CodeSpan text={token.text} />;
    case "br":
      return <br />;
    case "link": {
      const children = <Links value={undefined}>{inline(token.tokens, extensions)}</Links>;
      const custom = links?.link(token.href, children);
      if (custom !== undefined) return custom;
      const href = safeHref(token.href);
      if (!href)
        return (
          <ThreadReference reference={token.href}>
            {inline(token.tokens, extensions)}
          </ThreadReference>
        );
      // A pull request opens in a side panel: the enclosing PR tab's, or the thread's.
      const pr = pullRequestAt(href);
      if (pr)
        return (
          <PullRequestLink threadId={scope?.threadId} href={href} pr={pr} className={linkClass}>
            {children}
          </PullRequestLink>
        );
      return (
        <WebLink href={href} className={linkClass}>
          {children}
        </WebLink>
      );
    }
    case "image":
      return <MarkdownImageToken href={token.href} alt={token.text} />;
    case "text":
      return token.tokens ? inline(token.tokens, extensions) : <ProseText text={token.text} />;
    case "escape":
      return token.text;
    case "html":
      return token.text;
    case "checkbox":
      return <Checkbox token={token} />;
    default:
      return "raw" in token ? token.raw : null;
  }
}

const headingClass = [
  "",
  "text-[1.25em] font-semibold",
  "text-[1.1em] font-semibold",
  "font-semibold",
];

export { blockRhythm };

/** A table as wide as its content up to the column; a clipped side fades when it scrolls. */
function Table(props: { token: Extract<MarkedToken, { type: "table" }> }): ReactNode {
  const tail = useContext(Tail);
  const extensions = useContext(Extensions);
  const token = props.token;
  const scroller = useRef<HTMLDivElement>(null);
  const fade = useEdgeFade(scroller);
  return (
    <div
      ref={scroller}
      className="max-w-full overflow-x-auto"
      style={fade ? { maskImage: fade } : undefined}
    >
      <table className="w-max max-w-full border-collapse text-[0.9em]">
        <thead className="bg-surface-1">
          <tr>
            {token.header.map((cell, index) => (
              <th
                key={index}
                style={{ textAlign: cell.align ?? undefined }}
                className="border-b px-2 py-1.5 text-left font-semibold"
              >
                {inline(cell.tokens, extensions)}
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
                  {inline(cell.tokens, extensions)}
                  {rowIndex === token.rows.length - 1 && index === row.length - 1 && tail}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Inside a block still being written: its code shows plain until the block settles. */
const Writing = createContext(false);
const Tail = createContext<ReactNode>(undefined);

function Block(props: { token: Token; code?: MarkdownBlock["code"] }): ReactNode {
  const writing = useContext(Writing);
  const tail = useContext(Tail);
  const extensions = useContext(Extensions);
  const token = props.token;
  if (!isKnown(token))
    return (
      <p>
        {token.raw}
        {tail}
      </p>
    );
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "paragraph": {
      const standard = () => (
        <p>
          {inline(token.tokens, extensions)}
          {tail}
        </p>
      );
      const custom = extensions?.paragraph(token, standard);
      return custom === undefined ? standard() : custom;
    }
    case "heading": {
      const Tag = `h${Math.min(6, Math.max(3, token.depth + 2))}` as "h3" | "h4" | "h5" | "h6";
      return (
        <Tag className={headingClass[Math.min(3, token.depth)] ?? headingClass[3]}>
          {inline(token.tokens, extensions)}
          {tail}
        </Tag>
      );
    }
    case "code":
      return (
        <CodeBlock
          code={token.text}
          lang={token.lang}
          tail={tail}
          {...(props.code ? { tokens: props.code } : writing ? { plain: true } : {})}
        />
      );
    case "blockquote": {
      const custom = extensions?.blockquote(token, (tokens) => <Blocks tokens={tokens} />);
      if (custom !== undefined) return custom;
      return (
        <blockquote className={cn("border-l-2 pl-3 text-muted-foreground", blockRhythm)}>
          <Blocks tokens={token.tokens} />
        </blockquote>
      );
    }
    case "hr":
      return <hr className="border-0 border-t" />;
    case "list": {
      const items = token.items.map((item, index) => (
        <li
          key={index}
          className={cn(
            "[&+li]:mt-1 [&>ol]:mt-1 [&>ul]:mt-1",
            item.task ? "list-none" : "pl-0.5",
            item.loose && blockRhythm,
          )}
        >
          {/* Task items carry their own checkbox token. */}
          <Tail.Provider value={index === token.items.length - 1 ? tail : undefined}>
            {item.loose ? <Blocks tokens={item.tokens} /> : <Tight tokens={item.tokens} />}
          </Tail.Provider>
        </li>
      ));
      return token.ordered ? (
        <ol
          start={token.start === "" ? undefined : token.start}
          className="list-decimal pl-5 marker:text-subtle-foreground"
        >
          {items}
        </ol>
      ) : (
        <ul className="list-disc pl-5 marker:text-subtle-foreground">{items}</ul>
      );
    }
    case "table":
      return <Table token={token} />;
    case "html":
      if (extensions) return extensions.blocks([token], () => null);
      return (
        <p className="whitespace-pre-wrap">
          {token.text}
          {tail}
        </p>
      );
    case "text":
      return (
        <p>
          {token.tokens ? inline(token.tokens, extensions) : token.text}
          {tail}
        </p>
      );
    default:
      return (
        <>
          <Inline token={token} />
          {tail}
        </>
      );
  }
}

/** List items without blank lines between them hold bare inline text, not paragraphs. */
function Tight(props: { tokens: readonly Token[] }) {
  const tail = useContext(Tail);
  return props.tokens.map((token, index) =>
    token.type === "text" ? (
      <span key={index}>
        <Inline token={token} />
        {index === props.tokens.length - 1 && tail}
      </span>
    ) : (
      <Tail.Provider key={index} value={index === props.tokens.length - 1 ? tail : undefined}>
        <Block token={token} />
      </Tail.Provider>
    ),
  );
}

function Blocks(props: { tokens: readonly Token[] }) {
  const tail = useContext(Tail);
  const extensions = useContext(Extensions);
  const draw = (index: number) => {
    const token = props.tokens[index];
    return token ? (
      <Tail.Provider key={index} value={index === props.tokens.length - 1 ? tail : undefined}>
        <Block token={token} />
      </Tail.Provider>
    ) : null;
  };
  if (extensions && props.tokens.some((token) => token.type === "html"))
    return extensions.blocks(props.tokens, draw);
  return props.tokens.map((_, index) => draw(index));
}

/**
 * One top-level block. A settled block keeps its object, so it never renders again; an open
 * one is new on each update and patches its elements in place, and keeps its place (its key)
 * when it settles, so settling only highlights its code.
 */
const TopBlock = memo(function TopBlock(props: { block: MarkdownBlock; writing: boolean }) {
  return (
    <Writing.Provider value={props.writing}>
      <Block token={props.block.token} {...(props.block.code ? { code: props.block.code } : {})} />
    </Writing.Provider>
  );
});

/**
 * Transcript prose (15.5/1.6), lexed and highlighted in the markdown worker. `stream` names a
 * message whose text grows while `streaming`: its finished blocks render once, and only its
 * open block re-renders, 10 to 20 times a second. Until the first document is ready a
 * streaming message shows plain text; settled text reserves its place with a skeleton.
 */
export const Markdown = memo(function Markdown(props: {
  text: string;
  links?: MarkdownLinks | undefined;
  stream?: string | undefined;
  streaming?: boolean | undefined;
  className?: string | undefined;
  tail?: ReactNode;
  thread?: { threadId: string; cwd?: string; itemId?: string } | undefined;
  /** What a feature draws instead of the defaults (forge text); none for agent prose. */
  extensions?: MarkdownExtensions | undefined;
}) {
  const doc = useMarkdown(props.text, props.stream, !props.streaming);
  if (!doc)
    return (
      <MarkdownLoading
        text={props.text}
        className={props.className}
        streaming={props.streaming}
        tail={props.tail}
      />
    );
  const draw = (index: number) => {
    const block = doc.blocks[index];
    // A block's place is its identity: the open block keeps it when it settles.
    return block ? (
      <Tail.Provider key={index} value={index === doc.blocks.length - 1 ? props.tail : undefined}>
        <TopBlock block={block} writing={index >= doc.settled} />
      </Tail.Provider>
    ) : null;
  };
  const extensions = props.extensions;
  const tokens = extensions ? doc.blocks.map((block) => block.token) : undefined;
  // Before any block renders: the extensions read the whole document once (task lists).
  const after =
    extensions && tokens
      ? extensions.document(tokens, (inner) => inline(inner, extensions))
      : undefined;
  return (
    <Links value={props.links}>
      <Extensions value={extensions}>
        <ThreadReferenceScope value={props.thread}>
          <div className={cn(blockRhythm, props.className)} onCopy={copyTexSource}>
            {doc.blocks.length === 0 && props.tail}
            {extensions && tokens?.some((token) => token.type === "html")
              ? extensions.blocks(tokens, draw)
              : doc.blocks.map((_, index) => draw(index))}
            {after}
          </div>
        </ThreadReferenceScope>
      </Extensions>
    </Links>
  );
});
