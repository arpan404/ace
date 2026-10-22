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
import { htmlPieces } from "./html-pieces.ts";
import { safeImage } from "./html-policy.ts";
import { HtmlNodes } from "./html-render.tsx";
import { htmlTree, type RunEntry } from "./html-tree.ts";

/*
 * How forge text draws what agent prose doesn't (ADR 0096), as extensions to the shared
 * renderer: raw HTML through the sanitizer, images and videos through the daemon, alerts,
 * task boxes and footnotes. One set per document (its text and edit), made by `ForgeProse`.
 */

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const attachment = new RegExp(`^/user-attachments/assets/${uuid}/?$`, "i");
const repositoryAsset = new RegExp(`^/[^/]+/[^/]+/assets/\\d+/${uuid}/?$`, "i");
const videoFile = /\.(mp4|mov|webm)$/i;

/** A link GitHub may show as a player when it stands alone on its line. */
export function mediaLink(href: string, host: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.hostname === host)
    return attachment.test(url.pathname) || repositoryAsset.test(url.pathname);
  return url.hostname.endsWith("githubusercontent.com") && videoFile.test(url.pathname);
}

/** A run of tokens as entries for `htmlTree`: HTML tokens split into pieces. */
function runOf(tokens: readonly Token[]): RunEntry[] {
  return tokens.map((token, index) =>
    token.type === "html"
      ? { kind: "html", pieces: htmlPieces(token.text) }
      : { kind: "token", index },
  );
}

/** Every task box in `tokens`, in document order. */
function taskBoxes(tokens: readonly Token[], into: Map<Token, number>): void {
  for (const token of tokens) {
    if (token.type === "checkbox") into.set(token, into.size);
    if (token.type === "list") taskBoxes((token as Tokens.List).items, into);
    if ("tokens" in token && Array.isArray(token.tokens)) taskBoxes(token.tokens, into);
  }
}

export function forgeExtensions(input: {
  host: string;
  footnotes: ReadonlyMap<string, number>;
  tasks: TaskControl | undefined;
}): MarkdownExtensions {
  let boxes = new Map<Token, number>();
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
    checkbox: (token) => (
      <TaskBox
        checked={token.checked}
        index={boxes.get(token)}
        drawn={boxes.size}
        control={input.tasks}
      />
    ),
    document: (tokens, inline) => {
      boxes = new Map();
      taskBoxes(tokens, boxes);
      return input.footnotes.size ? <Footnotes tokens={tokens} inline={inline} /> : null;
    },
  };
}
