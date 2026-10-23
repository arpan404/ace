import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { GithubLogoIcon } from "@phosphor-icons/react";
import type { ForgeRepository } from "@ace/protocol";
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
/**
 * Links for one PR's text. What they draw depends only on the PR and whether references open in
 * place; clicks call `actions`, which reach the newest props, so the links stay the same while
 * the PR does.
 */
function forgeLinks(
  shown: { repository: ForgeRepository; number: number; references: boolean },
  actions: { open(number: number): void; refer(number: number): void },
): {
  reference(number: number, children: ReactNode): ReactNode;
  link: MarkdownLinks["link"];
} {
  const { repository } = shown;
  const reference = (number: number, children: ReactNode) => {
    const onClick =
      number === shown.number
        ? () => actions.open(number)
        : shown.references
          ? () => actions.refer(number)
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
            onClick={() => actions.open(Number(match[4]))}
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
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const { detail, workspaceId } = props.context;
  const repository = detail.status.ref.repository;
  const number = detail.status.ref.number;
  const references = props.extensions?.reference !== undefined;
  const prKey = `${repository.host}/${repository.owner}/${repository.name}#${number}`;
  // Clicks reach the newest props; nothing here reads them while drawing.
  const open = useCallback((target: number) => latest.current.onOpen(target), []);
  const refer = useCallback(
    (target: number) => latest.current.extensions?.reference?.(target, latest.current.context),
    [],
  );
  // Keyed on the PR, not on props (a new object each render), so polls don't redraw the text.
  const links = useMemo(
    // `open` and `refer` read the ref only when clicked, never while drawing.
    // oxlint-disable-next-line react-compiler/refs, react-hooks/refs
    () => forgeLinks({ repository, number, references }, { open, refer }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `prKey` names the repository.
    [prKey, number, references, open, refer],
  );
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- `prKey` names the repository.
  const scope = useMemo(() => ({ workspaceId, repository }), [workspaceId, prKey]);
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
