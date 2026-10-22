// oxlint-disable react/no-array-index-key -- HTML nodes have no identity; position is it.
import { CaretRightIcon } from "@phosphor-icons/react";
import { createElement, useContext, type ReactNode } from "react";
import { codeSpanClass } from "@/components/inline-markdown.tsx";
import { blockRhythm } from "@/components/markdown/rhythm.ts";
import { WebLink } from "@/components/web-link.tsx";
import { cn } from "@/lib/cn.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { ForgeImage } from "./forge-media.tsx";
import { ForgeDocument, ForgeText, forgeLinkClass, scrollToAnchor } from "./forge-text.tsx";
import type { HtmlNode } from "./html-tree.ts";
import { InsideLink } from "./scope.ts";

/*
 * Sanitized HTML from forge text as React elements (ADR 0096). Only elements `html-policy.ts`
 * allowed reach here, with only the attributes it kept; nothing is ever injected as markup.
 * Markdown tokens the HTML wraps are drawn by the renderer (`draw`).
 */

type Draw = (index: number) => ReactNode;
type Element = Extract<HtmlNode, { kind: "element" }>;

const alignText: Record<string, string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
  justify: "text-justify",
};
const heading: Record<string, string> = {
  h1: "text-[1.25em] font-semibold",
  h2: "text-[1.1em] font-semibold",
};
/** Plain elements: drawn as themselves with a quiet look. */
const styled: Record<string, string> = {
  b: "font-semibold",
  strong: "font-semibold",
  i: "italic",
  em: "italic",
  ins: "underline",
  u: "underline",
  del: "text-muted-foreground line-through",
  s: "text-muted-foreground line-through",
  strike: "text-muted-foreground line-through",
  sub: "",
  sup: "",
  small: "text-[0.85em]",
  mark: "rounded-xs bg-fill-strong px-0.5 text-foreground",
  kbd: "rounded-xs border border-border-strong bg-surface-1 px-1 py-px font-mono text-[0.85em] text-foreground",
  code: codeSpanClass,
  tt: "font-mono text-[0.92em]",
  samp: "font-mono text-[0.92em]",
  var: "italic",
  abbr: "underline decoration-dotted underline-offset-2",
  q: "",
  cite: "italic",
  dfn: "italic",
  span: "",
  time: "",
  bdo: "",
  ruby: "",
  rt: "text-[0.7em]",
  rp: "",
  blockquote: cn("border-l-2 pl-3 text-muted-foreground", blockRhythm),
  pre: "overflow-x-auto rounded-lg bg-code p-3 font-mono text-[0.9em] leading-snug",
  ul: "list-disc pl-5 marker:text-subtle-foreground",
  ol: "list-decimal pl-5 marker:text-subtle-foreground",
  li: "pl-0.5 [&+li]:mt-1",
  dl: "",
  dt: "font-semibold",
  dd: "pl-4",
  figure: "",
  figcaption: "text-xs text-subtle-foreground",
  caption: "pb-1 text-left text-xs text-subtle-foreground",
  table: "w-max max-w-full border-collapse text-[0.9em]",
  thead: "bg-surface-1",
  tbody: "",
  tfoot: "",
  tr: "",
  th: "border-b px-2 py-1.5 text-left font-semibold",
  td: "border-b px-2 py-1.5",
  hr: "border-0 border-t",
  br: "",
  wbr: "",
};

function Children(props: { nodes: readonly HtmlNode[]; draw: Draw }): ReactNode {
  return props.nodes.map((node, index) => <Node key={index} node={node} draw={props.draw} />);
}

function Node(props: { node: HtmlNode; draw: Draw }): ReactNode {
  const { node } = props;
  if (node.kind === "token") return props.draw(node.index);
  if (node.kind === "text") return <ForgeText text={node.text} />;
  return <ElementNode node={node} draw={props.draw} />;
}

/** Whether a node draws nothing but whitespace. */
const blank = (node: HtmlNode) => node.kind === "text" && !node.text.trim();

function Details(props: { node: Element; draw: Draw }): ReactNode {
  const summary = props.node.children.find(
    (child): child is Element => child.kind === "element" && child.tag === "summary",
  );
  const body = props.node.children.filter((child) => child !== summary && !blank(child));
  return (
    <details open={props.node.attrs.open !== undefined}>
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-xs select-none focus-ring [&::-webkit-details-marker]:hidden">
        <CaretRightIcon
          aria-hidden
          size={12}
          className="shrink-0 text-faint-foreground transition-transform duration-(--motion-fast) [details[open]>summary>&]:rotate-90"
        />
        <span>{summary ? <Children nodes={summary.children} draw={props.draw} /> : "Details"}</span>
      </summary>
      {body.length > 0 && (
        <div className={cn("mt-2 pl-4", blockRhythm)}>
          <Children nodes={body} draw={props.draw} />
        </div>
      )}
    </details>
  );
}

/** Every element below `node`, depth first. */
function* descendants(node: Element): Generator<Element> {
  for (const child of node.children)
    if (child.kind === "element") {
      yield child;
      yield* descendants(child);
    }
}

/** `<picture>`: the `<source>` whose media query matches ace's light or dark mode, else its `<img>`. */
function Picture(props: { node: Element }): ReactNode {
  const scheme = useTheme().resolved.scheme;
  const all = [...descendants(props.node)];
  const image = all.find((element) => element.tag === "img");
  const source = all.find((element) => {
    const media = element.attrs.media?.replaceAll(" ", "").toLowerCase() ?? "";
    return (
      element.tag === "source" &&
      element.attrs.srcset &&
      media.includes(`prefers-color-scheme:${scheme}`)
    );
  });
  const src = source?.attrs.srcset ?? image?.attrs.src;
  if (!src) return null;
  return (
    <ForgeImage
      src={src}
      alt={image?.attrs.alt ?? ""}
      title={image?.attrs.title}
      width={image?.attrs.width}
      height={image?.attrs.height}
      align={image?.attrs.align}
    />
  );
}

function Anchor(props: { node: Element; draw: Draw }): ReactNode {
  const doc = useContext(ForgeDocument);
  const { href, title, id } = props.node.attrs;
  const children = (
    <InsideLink value>
      <Children nodes={props.node.children} draw={props.draw} />
    </InsideLink>
  );
  const anchorId = id ? `${doc.anchor}${id}` : undefined;
  if (!href) return <span id={anchorId}>{children}</span>;
  if (href.startsWith("#"))
    return (
      <a
        id={anchorId}
        href={href}
        title={title}
        onClick={(event) => scrollToAnchor(event, `${doc.anchor}${href.slice(1)}`)}
        className={forgeLinkClass}
      >
        {children}
      </a>
    );
  return (
    <WebLink id={anchorId} href={href} title={title} className={forgeLinkClass}>
      {children}
    </WebLink>
  );
}

function ElementNode(props: { node: Element; draw: Draw }): ReactNode {
  const { node, draw } = props;
  const { attrs, tag } = node;
  const align = attrs.align ? alignText[attrs.align] : undefined;
  const children = <Children nodes={node.children} draw={draw} />;
  switch (tag) {
    case "img":
      return attrs.src ? (
        <ForgeImage
          src={attrs.src}
          alt={attrs.alt ?? ""}
          title={attrs.title}
          width={attrs.width}
          height={attrs.height}
          align={attrs.align}
        />
      ) : null;
    case "picture":
      return <Picture node={node} />;
    case "source":
      return null;
    case "a":
      return <Anchor node={node} draw={draw} />;
    case "details":
      return <Details node={node} draw={draw} />;
    case "summary":
      return <span className="font-medium">{children}</span>;
    case "p":
      return <p className={align}>{children}</p>;
    case "div":
    case "center":
      return (
        <div className={cn(blockRhythm, tag === "center" ? "text-center" : align)}>{children}</div>
      );
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return createElement(
        `h${Math.min(6, Number(tag.slice(1)) + 2)}`,
        { className: cn(heading[tag] ?? "font-semibold", align) },
        children,
      );
    case "table":
      return (
        <div className="max-w-full overflow-x-auto">
          <table className={styled.table}>
            <Children nodes={node.children.filter((child) => !blank(child))} draw={draw} />
          </table>
        </div>
      );
    case "thead":
    case "tbody":
    case "tfoot":
    case "tr":
      // Whitespace between table parts isn't allowed in the DOM.
      return createElement(
        tag,
        { className: styled[tag] || undefined },
        <Children nodes={node.children.filter((child) => !blank(child))} draw={draw} />,
      );
    case "td":
    case "th":
      return createElement(
        tag,
        {
          className: cn(styled[tag], align),
          colSpan: attrs.colspan ? Number(attrs.colspan) : undefined,
          rowSpan: attrs.rowspan ? Number(attrs.rowspan) : undefined,
        },
        children,
      );
    case "ol":
      return (
        <ol className={styled.ol} start={attrs.start ? Number(attrs.start) : undefined}>
          {children}
        </ol>
      );
    case "br":
      return <br />;
    case "hr":
      return <hr className={styled.hr} />;
    case "wbr":
      return <wbr />;
    default:
      return createElement(
        tag,
        {
          className: styled[tag] || undefined,
          ...(attrs.title ? { title: attrs.title } : {}),
          ...(attrs.dir ? { dir: attrs.dir } : {}),
          ...(attrs.datetime ? { dateTime: attrs.datetime } : {}),
          ...(attrs.cite ? { cite: attrs.cite } : {}),
        },
        children,
      );
  }
}

/** A run's tree, drawn. */
export function HtmlNodes(props: { nodes: readonly HtmlNode[]; draw: Draw; block: boolean }) {
  // Between blocks, whitespace from the HTML's own line breaks draws nothing.
  if (!props.block) return <Children nodes={props.nodes} draw={props.draw} />;
  // Text between blocks (a tag shown as text) takes a paragraph's place in the rhythm.
  return props.nodes
    .filter((node) => !blank(node))
    .map((node, index) =>
      node.kind === "text" ? (
        <p key={index} className="whitespace-pre-wrap">
          <ForgeText text={node.text.trim()} />
        </p>
      ) : (
        <Node key={index} node={node} draw={props.draw} />
      ),
    );
}
