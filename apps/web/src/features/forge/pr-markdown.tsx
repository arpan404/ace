import { useMemo, type ReactNode } from "react";
import { GithubLogoIcon } from "@phosphor-icons/react";
import type { MarkdownLinks } from "@/components/markdown/link-options.ts";
import { PullRequestLink, pullRequestAt } from "@/components/pull-request-link.tsx";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { WebLink } from "@/components/web-link.tsx";
import { ForgeProse } from "./rich/forge-prose.tsx";
import { ForgeContentScope } from "./rich/scope.ts";

type Props = {
  text: string;
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  onOpen(number: number): void;
  /** Saves the text with one task box ticked, when the viewer may edit it. */
  tasks?: ((next: string) => Promise<boolean>) | undefined;
};
function forgeLinks(props: Props): {
  reference(number: number, children: ReactNode): ReactNode;
  link: MarkdownLinks["link"];
} {
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
      <WebLink
        href={`https://${repository.host}/${repository.owner}/${repository.name}/issues/${number}`}
        className="text-link hover:underline focus-ring"
      >
        {children}
      </WebLink>
    );
  };
  return {
    reference,
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
      const className = "inline-flex items-center gap-1 text-link hover:underline focus-ring";
      // Another pull request opens in a tab beside this one; a comment's anchor stays on GitHub.
      const pr = url.hash ? undefined : pullRequestAt(url.href);
      if (pr)
        return (
          <PullRequestLink href={url.href} pr={pr} className={className}>
            <GithubLogoIcon aria-hidden size={14} />
            {children}
          </PullRequestLink>
        );
      return (
        <WebLink href={url.href} className={className}>
          <GithubLogoIcon aria-hidden size={14} />
          {children}
        </WebLink>
      );
    },
  };
}
/** PR text (description, check output): forge text whose own PRs and references open in place. */
export function PrMarkdown(props: Props) {
  const links = useMemo(() => forgeLinks(props), [props]);
  const { detail, workspaceId } = props.context;
  const repository = detail.status.ref.repository;
  const scope = useMemo(() => ({ workspaceId, repository }), [workspaceId, repository]);
  return (
    <ForgeContentScope value={scope}>
      <ForgeProse
        text={props.text}
        link={links.link}
        reference={links.reference}
        tasks={props.tasks}
        className="text-ui leading-normal text-muted-foreground"
      />
    </ForgeContentScope>
  );
}
