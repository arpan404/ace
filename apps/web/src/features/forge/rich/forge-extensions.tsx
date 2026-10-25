import type { Token, Tokens } from "marked";
import type { MarkdownExtensions } from "@/components/markdown/extensions.ts";
import {
  Alert,
  alertOf,
  footnoteLabel,
  Footnotes,
  TaskBox,
  type TaskControl,
} from "./forge-blocks.tsx";
import { ForgeImage, ForgeLinkMedia } from "./forge-media.tsx";
import {
  htmlPieces,
  mediaLink,
  safeImage,
  htmlTree,
  type RunEntry,
  taskMarks,
  type TaskMark,
} from "@ace/ui-core/forge-rich";
import { HtmlNodes } from "./html-render.tsx";
import { MermaidDiagram } from "./mermaid-diagram.tsx";

/*
 * How forge text draws what agent prose doesn't (ADR 0096), as extensions to the shared
 * renderer: raw HTML through the sanitizer, images and videos through the daemon, alerts,
 * task boxes and footnotes. One set per document (its text and edit), made by `ForgeProse`.
 */

/** A run of tokens as entries for `htmlTree`: HTML tokens split into pieces. */
function runOf(tokens: readonly Token[]): RunEntry[] {
  return tokens.map((token, index) =>
    token.type === "html"
      ? { kind: "html", pieces: htmlPieces(token.text) }
      : { kind: "token", index },
  );
}

export function forgeExtensions(input: {
  host: string;
  /** The document's markdown, where its task boxes are placed. */
  source: string;
  footnotes: ReadonlyMap<string, number>;
  tasks: TaskControl | undefined;
}): MarkdownExtensions {
  let marks = new Map<Token, TaskMark>();
  return {
    blocks: (tokens, draw) => (
      <HtmlNodes nodes={htmlTree(runOf(tokens), input.host)} draw={draw} block />
    ),
    inlines: (tokens, draw) => (
      <HtmlNodes nodes={htmlTree(runOf(tokens), input.host)} draw={draw} block={false} />
    ),
    image: (href, alt) => {
      const src = safeImage(href, input.host);
      return src ? <ForgeImage src={src} alt={alt} /> : alt;
    },
    blockquote: (token, blocks) => {
      const alert = alertOf(token);
      return alert ? <Alert kind={alert.kind}>{blocks(alert.tokens)}</Alert> : undefined;
    },
    paragraph: (token, standard) => {
      const label = footnoteLabel(token);
      // Drawn with the footnotes, after the last block.
      if (label !== undefined && input.footnotes.has(label)) return null;
      const [only, ...rest] = token.tokens;
      if (!rest.length && only?.type === "link") {
        const link = only as Tokens.Link;
        if (link.text === link.href && mediaLink(link.href, input.host))
          return <ForgeLinkMedia url={link.href} standard={standard()} />;
      }
      return undefined;
    },
    code: (token, standard) =>
      token.lang?.trim().toLowerCase() === "mermaid" ? (
        <MermaidDiagram source={token.text} code={standard()} />
      ) : undefined,
    checkbox: (token) => (
      <TaskBox checked={token.checked} mark={marks.get(token)} control={input.tasks} />
    ),
    document: (tokens, inline) => {
      marks = taskMarks(input.source, tokens);
      return input.footnotes.size ? <Footnotes tokens={tokens} inline={inline} /> : null;
    },
  };
}
