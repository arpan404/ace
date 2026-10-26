// oxlint-disable react/no-array-index-key -- segments have no identity; position is it.
import { createContext, useContext, type MouseEvent, type ReactNode } from "react";
import { WebLink } from "@/components/web-link.tsx";
import { shortcodePattern, useEmojiNames } from "./emoji.ts";
import { useImageEmoji } from "./image-emoji.ts";
import { useForgeMedia } from "./use-forge-media.ts";
import { ForgeContentScope, InsideCode, InsideLink } from "./scope.ts";
import { textSegments, type TextSegment } from "@ace/ui-core/forge-rich";

/** One document's footnotes and the prefix that keeps its anchors apart from other documents'. */
export const ForgeDocument = createContext<{
  footnotes: ReadonlyMap<string, number>;
  anchor: string;
}>({ footnotes: new Map(), anchor: "" });

/** A segment as the text it was written as. */
function plainOf(segment: TextSegment): string {
  if (segment.kind === "footnote") return `[^${segment.label}]`;
  if (segment.kind === "emoji" || segment.kind === "image-emoji") return `:${segment.code}:`;
  if (segment.kind === "commit")
    return segment.owner ? `${segment.owner}/${segment.repo}@${segment.sha}` : segment.sha;
  return segment.text;
}

/** One of GitHub's image emoji, through the daemon; its shortcode until (or unless) it loads. */
function ImageEmoji(props: { url: string; code: string }) {
  const view = useForgeMedia(props.url, "image");
  if (view.phase !== "ready") return `:${props.code}:`;
  return (
    <img
      src={view.url}
      alt={`:${props.code}:`}
      title={`:${props.code}:`}
      draggable={false}
      className="inline-block h-[1.2em] w-auto align-[-0.2em]"
    />
  );
}

export const forgeLinkClass =
  "text-link underline decoration-ring/40 underline-offset-[3px] wrap-break-word hover:decoration-current";

/** Scroll to an anchor of this document instead of changing the page's address. */
export function scrollToAnchor(event: MouseEvent, id: string): void {
  event.preventDefault();
  document.getElementById(id)?.scrollIntoView({ block: "center", behavior: "smooth" });
}

/**
 * Plain text from forge text with what GitHub draws inside it: emoji for shortcodes, @mentions
 * and `#123` linked, footnote markers as numbered links. `reference` draws `#123` (the PR view
 * opens its own); by default it links the repository's issue, which ace opens where it can.
 */
export function ForgeText(props: {
  text: string;
  reference?: ((number: number, text: string) => ReactNode) | undefined;
}): ReactNode {
  const scope = useContext(ForgeContentScope);
  const inLink = useContext(InsideLink);
  const inCode = useContext(InsideCode);
  const doc = useContext(ForgeDocument);
  const emoji = useEmojiNames(shortcodePattern.test(props.text));
  // GitHub's own image emoji are read only for a shortcode its Unicode list doesn't know.
  const imageEmoji = useImageEmoji(
    !!emoji &&
      // A shortcode names something: `10:30:45` holds none.
      [...props.text.matchAll(/:([a-z0-9_+-]*[a-z][a-z0-9_+-]*):/g)].some(
        (match) => (match[1]?.length ?? 0) <= 64 && !emoji.has(match[1] ?? ""),
      ),
  );
  // GitHub leaves code as written, and links nothing inside a link (no link in a link).
  const segments = inCode
    ? [{ kind: "text" as const, text: props.text }]
    : textSegments(props.text, { emoji, imageEmoji, footnotes: doc.footnotes }).map((segment) =>
        inLink && !["emoji", "image-emoji", "text"].includes(segment.kind)
          ? { kind: "text" as const, text: plainOf(segment) }
          : segment,
      );
  if (segments.length === 1 && segments[0]?.kind === "text") return props.text;
  const host = scope?.repository.host ?? "github.com";
  return segments.map((segment, index) => {
    switch (segment.kind) {
      case "text":
        return segment.text;
      case "emoji":
        return (
          <span key={index} role="img" aria-label={segment.code.replaceAll("_", " ")}>
            {segment.emoji}
          </span>
        );
      case "image-emoji":
        return <ImageEmoji key={index} url={segment.url} code={segment.code} />;
      case "cross-reference":
        // A PR or issue elsewhere opens inside ace where the page can open it.
        return (
          <WebLink
            key={index}
            href={`https://${host}/${segment.owner}/${segment.repo}/issues/${segment.number}`}
            className={forgeLinkClass}
          >
            {segment.text}
          </WebLink>
        );
      case "commit": {
        const owner = segment.owner ?? scope?.repository.owner;
        const name = segment.repo ?? scope?.repository.name;
        if (!owner || !name) return segment.text;
        return (
          <WebLink
            key={index}
            href={`https://${host}/${owner}/${name}/commit/${segment.sha}`}
            className="text-link hover:underline focus-ring"
          >
            <code className="rounded-xs bg-code px-1 py-px font-mono text-[0.88em]">
              {segment.text}
            </code>
          </WebLink>
        );
      }
      case "mention":
        return (
          <WebLink
            key={index}
            href={
              segment.team
                ? `https://${host}/orgs/${segment.login}/teams/${segment.team}`
                : `https://${host}/${segment.login}`
            }
            className="font-medium text-foreground hover:underline focus-ring"
          >
            {segment.text}
          </WebLink>
        );
      case "reference":
        if (props.reference)
          return <span key={index}>{props.reference(segment.number, segment.text)}</span>;
        return scope ? (
          <WebLink
            key={index}
            href={`https://${host}/${scope.repository.owner}/${scope.repository.name}/issues/${segment.number}`}
            className={forgeLinkClass}
          >
            {segment.text}
          </WebLink>
        ) : (
          segment.text
        );
      case "footnote": {
        const target = `${doc.anchor}fn-${segment.label}`;
        return (
          <sup key={index} id={`${doc.anchor}fnref-${segment.label}`}>
            <a
              href={`#${target}`}
              aria-label={`Footnote ${segment.number}`}
              onClick={(event) => scrollToAnchor(event, target)}
              className="text-link hover:underline focus-ring"
            >
              {segment.number}
            </a>
          </sup>
        );
      }
    }
  });
}
