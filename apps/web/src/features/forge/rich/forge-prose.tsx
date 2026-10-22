import { useContext, useId, useMemo, type ReactNode } from "react";
import type { MarkdownLinks } from "@/components/markdown/link-options.ts";
import { Prose } from "@/components/markdown/prose.tsx";
import { WebLink } from "@/components/web-link.tsx";
import { forgeExtensions } from "./forge-extensions.tsx";
import { ForgeDocument, ForgeText, forgeLinkClass } from "./forge-text.tsx";
import { decodeEntities } from "./html-pieces.ts";
import { safeLink } from "./html-policy.ts";
import { ForgeContentScope, InsideLink } from "./scope.ts";
import { footnoteNumbers } from "./source-marks.ts";

/** Plain text and links in forge text: GitHub's decorations, and links that open where they can. */
function proseLinks(
  host: string,
  link: MarkdownLinks["link"] | undefined,
  reference: ((number: number, text: string) => ReactNode) | undefined,
): MarkdownLinks {
  return {
    text: (value) => <ForgeText text={decodeEntities(value)} reference={reference} />,
    link(href, children) {
      const inside = <InsideLink value>{children}</InsideLink>;
      const custom = link?.(href, inside);
      if (custom !== undefined) return custom;
      const safe = safeLink(href, host);
      if (!safe || safe.startsWith("#")) return <span>{children}</span>;
      return (
        <WebLink href={safe} className={forgeLinkClass}>
          {inside}
        </WebLink>
      );
    },
  };
}

/**
 * Text people wrote on a pull request or issue (descriptions, comments, reviews), drawn the way
 * GitHub draws it (ADR 0096): GitHub's HTML subset, images and videos (through the daemon, from
 * the page's `ForgeContentScope`), light and dark `<picture>`s, alerts, emoji, @mentions, task
 * lists and footnotes. Agent prose keeps `Prose`; this composes it with forge extensions.
 *
 * `link` takes a link over (the PR view opens its own PRs in place); `reference` draws `#123`;
 * `tasks` saves the text with one box ticked, when the viewer may edit it.
 */
export function ForgeProse(props: {
  text: string;
  className?: string | undefined;
  link?: MarkdownLinks["link"] | undefined;
  reference?: ((number: number, text: string) => ReactNode) | undefined;
  tasks?: ((next: string) => Promise<boolean>) | undefined;
}): ReactNode {
  const scope = useContext(ForgeContentScope);
  const host = scope?.repository.host ?? "github.com";
  const anchor = `${useId().replaceAll(":", "")}-`;
  const { text, link, reference, tasks } = props;
  const footnotes = useMemo(() => footnoteNumbers(text), [text]);
  const doc = useMemo(() => ({ footnotes, anchor }), [footnotes, anchor]);
  const links = useMemo(() => proseLinks(host, link, reference), [host, link, reference]);
  const extensions = useMemo(
    () =>
      forgeExtensions({
        host,
        source: text,
        footnotes,
        tasks: tasks ? { source: text, change: tasks } : undefined,
      }),
    [host, footnotes, tasks, text],
  );
  return (
    <ForgeDocument value={doc}>
      <Prose
        text={text}
        links={links}
        extensions={extensions}
        {...(props.className ? { className: props.className } : {})}
      />
    </ForgeDocument>
  );
}
