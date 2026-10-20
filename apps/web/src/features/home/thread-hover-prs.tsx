import type { LinkedPullRequest } from "@ace/protocol";
import { PullRequestGlyph } from "@/components/pull-request-state.tsx";

/** Dense, single-line PRs; separate repositories keep identical PR numbers unambiguous. */
export function ThreadHoverPrs(props: { prs: readonly LinkedPullRequest[] }) {
  const repositories = new Map<string, LinkedPullRequest[]>();
  for (const pr of props.prs) {
    const key = `${pr.repo.host}/${pr.repo.owner}/${pr.repo.name}`;
    const group = repositories.get(key);
    if (group) group.push(pr);
    else repositories.set(key, [pr]);
  }
  return (
    <div className="max-h-60 overflow-y-auto overscroll-contain" aria-label="Linked pull requests">
      {[...repositories].map(([repository, prs]) => (
        <div key={repository}>
          {repositories.size > 1 && (
            <p className="truncate pt-1 text-xs text-subtle-foreground" title={repository}>
              {repository}
            </p>
          )}
          <ul aria-label={`Pull requests in ${repository}`}>
            {prs.map((pr) => (
              <li
                key={pr.number}
                className="flex h-5 min-w-0 items-center gap-1.5 text-ui"
                title={`#${pr.number} · ${pr.state}${pr.title ? ` · ${pr.title}` : ""}`}
                aria-label={`#${pr.number}, ${pr.state}${pr.title ? `, ${pr.title}` : ""}`}
              >
                <PullRequestGlyph state={pr.state} size={14} />
                <span className="w-12 shrink-0 text-subtle-foreground tabular-nums">
                  #{pr.number}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {pr.title ?? `${pr.repo.owner}/${pr.repo.name}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
