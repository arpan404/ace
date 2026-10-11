import { useMemo, type ReactNode } from "react";
import { GithubLogoIcon } from "@phosphor-icons/react";
import { Prose } from "@/components/markdown/prose.tsx";
import type { MarkdownLinks } from "@/components/markdown/link-options.ts";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";

type Props = {
  text: string;
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  onOpen(number: number): void;
};
function forgeLinks(props: Props): MarkdownLinks {
  const repository = props.context.detail.status.ref.repository;
  const reference = (number: number, children: ReactNode) => {
    const known = number === props.context.detail.status.ref.number;
    const onClick = known
      ? () => props.onOpen(number)
      : props.extensions?.reference
        ? () => props.extensions?.reference?.(number, props.context)
        : undefined;
    return onClick ? (
      <button type="button" className="text-link hover:underline focus-ring" onClick={onClick}>
        {children}
      </button>
    ) : (
      <a
        href={`https://${repository.host}/${repository.owner}/${repository.name}/issues/${number}`}
        target="_blank"
        rel="noreferrer noopener"
        className="text-link hover:underline focus-ring"
      >
        {children}
      </a>
    );
  };
  return {
    text(text) {
      const nodes: ReactNode[] = [];
      let end = 0;
      for (const match of text.matchAll(/(?<![\w/#])#([1-9]\d*)\b/g)) {
        nodes.push(text.slice(end, match.index));
        nodes.push(<span key={match.index}>{reference(Number(match[1]), match[0])}</span>);
        end = match.index + match[0].length;
      }
      nodes.push(text.slice(end));
      return nodes;
    },
    link(href, children) {
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        return undefined;
      }
      if (url.protocol !== "https:" || url.host !== repository.host) return undefined;
      const match = /^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)\/?$/.exec(url.pathname);
      if (
        match &&
        match[1] === repository.owner &&
        match[2] === repository.name &&
        match[3] === "pull" &&
        !url.hash
      )
        return (
          <button
            type="button"
            onClick={() => props.onOpen(Number(match[4]))}
            className="inline-flex items-center gap-1 text-link hover:underline focus-ring"
          >
            <GithubLogoIcon aria-hidden size={14} />
            {children}
          </button>
        );
      return (
        <a
          href={url.href}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-link hover:underline focus-ring"
        >
          <GithubLogoIcon aria-hidden size={14} />
          {children}
        </a>
      );
    },
  };
}
export function PrMarkdown(props: Props) {
  const links = useMemo(() => forgeLinks(props), [props]);
  return (
    <Prose
      text={props.text}
      links={links}
      className="text-base leading-relaxed text-muted-foreground"
    />
  );
}
