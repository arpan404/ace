import type { ReactNode } from "react";
import type { LinkedPullRequest } from "@ace/protocol";
import { openExternal } from "@/boot/open-external.ts";
import { PullRequestGlyph } from "@/components/pull-request-state.tsx";
import { cn } from "@/lib/cn.ts";

/** Text that opens a web address in the device's browser; underlined under the pointer. */
export function ExternalLink(props: {
  href: string;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      aria-label={props.label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void openExternal(props.href).catch(() => {});
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
export function ThreadHoverPrs(props: { prs: readonly LinkedPullRequest[] }) {
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
                <ExternalLink
                  href={pr.url}
                  label={`Open pull request #${pr.number}`}
                  className="flex flex-1 items-center gap-1.5"
                >
                  <PullRequestGlyph state={pr.state} size={14} />
                  <span className="w-12 shrink-0 text-subtle-foreground tabular-nums">
                    #{pr.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {pr.title ?? `${pr.repo.owner}/${pr.repo.name}`}
                  </span>
                </ExternalLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
