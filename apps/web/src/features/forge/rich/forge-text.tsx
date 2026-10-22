// oxlint-disable react/no-array-index-key -- segments have no identity; position is it.
import { createContext, useContext, type MouseEvent, type ReactNode } from "react";
import { WebLink } from "@/components/web-link.tsx";
import { shortcodePattern, useEmojiNames } from "./emoji.ts";
import { ForgeContentScope } from "./scope.ts";
import { textSegments } from "./text-segments.ts";

/** One document's footnotes and the prefix that keeps its anchors apart from other documents'. */
export const ForgeDocument = createContext<{
  footnotes: ReadonlyMap<string, number>;
  anchor: string;
}>({ footnotes: new Map(), anchor: "" });

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
  const doc = useContext(ForgeDocument);
  const emoji = useEmojiNames(shortcodePattern.test(props.text));
  const segments = textSegments(props.text, { emoji, footnotes: doc.footnotes });
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
