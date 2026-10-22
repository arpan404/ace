import type { MouseEvent, ReactNode } from "react";
import type { LinkedPullRequest } from "@ace/protocol";
import { PullRequestGlyph } from "@/components/pull-request-state.tsx";
import { cn } from "@/lib/cn.ts";
import { useOpenThreadPullRequest } from "./open-pull-request.ts";

/** A linked pull request that opens ace's page for it; ⌘/Ctrl-click opens it on GitHub. */
export function LinkedPullRequestLink(props: {
  threadId: string;
  pr: LinkedPullRequest;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  const open = useOpenThreadPullRequest(props.threadId);
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    event.stopPropagation();
    open(props.pr, event);
  };
  return (
    <a
      href={props.pr.url}
      target="_blank"
      rel="noreferrer"
      aria-label={props.label ?? `Open pull request #${props.pr.number}`}
      onClick={(event) => {
        if (event.button === 0 && !event.shiftKey && !event.altKey) follow(event);
      }}
      onAuxClick={(event) => {
        if (event.button === 1) follow(event);
      }}
      className={cn(
        "min-w-0 truncate rounded-sm underline-offset-2 hover:underline focus-ring",
        props.className,
      )}
    >
      {props.children}
    </a>
  );
}

/** Dense, single-line PRs; separate repositories keep identical PR numbers unambiguous. */
export function ThreadHoverPrs(props: { threadId: string; prs: readonly LinkedPullRequest[] }) {
  const repositories = new Map<string, LinkedPullRequest[]>();
  for (const pr of props.prs) {
    const key = `${pr.repo.host}/${pr.repo.owner}/${pr.repo.name}`;
    const group = repositories.get(key);
    if (group) group.push(pr);
    else repositories.set(key, [pr]);
  }
  // The card scrolls as one; this list never adds a scroll of its own.
  return (
    <div aria-label="Linked pull requests">
      {[...repositories].map(([repository, prs]) => (
        <div key={repository}>
          {repositories.size > 1 && (
            <p className="truncate pt-1 text-xs text-subtle-foreground">{repository}</p>
          )}
          <ul aria-label={`Pull requests in ${repository}`}>
            {prs.map((pr) => (
              <li
                key={pr.number}
                className="flex h-5 min-w-0 items-center text-ui"
                aria-label={`#${pr.number}, ${pr.state}${pr.title ? `, ${pr.title}` : ""}`}
              >
                <LinkedPullRequestLink
                  threadId={props.threadId}
                  pr={pr}
                  className="flex flex-1 items-center gap-1.5"
                >
                  <PullRequestGlyph state={pr.state} size={14} />
                  <span className="w-12 shrink-0 text-subtle-foreground tabular-nums">
                    #{pr.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {pr.title ?? `${pr.repo.owner}/${pr.repo.name}`}
                  </span>
                </LinkedPullRequestLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
