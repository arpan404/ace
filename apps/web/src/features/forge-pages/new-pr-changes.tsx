import { useState } from "react";
import type { ForgeCommit, ForgeCompare } from "@ace/protocol";
import { Prose } from "@/components/markdown/prose.tsx";
import { PersonAvatar, RelativeTime } from "@/components/person-avatar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { PrCompareFiles, readFailureText } from "@/features/forge/index.ts";
import { useCompare } from "./new-pr-data.ts";

/**
 * What the new pull request brings: its commits, oldest first, each subject with its body
 * under it, and its changed files as diffs, a page of files at a time.
 */
export function NewPrChanges(props: {
  project: string;
  base: string;
  head: { owner: string; branch: string };
  first: ForgeCompare;
}) {
  const { first } = props;
  const [pages, setPages] = useState(1);
  return (
    <div className="mt-10 space-y-8">
      <section aria-label="Commits">
        <h2 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          Commits
          <span className="font-normal text-subtle-foreground tabular-nums">
            {first.totalCommits}
          </span>
        </h2>
        <ol className="divide-y divide-border-soft">
          {first.commits.map((commit) => (
            <CommitRow key={commit.sha} commit={commit} />
          ))}
        </ol>
        {first.totalCommits > first.commits.length && (
          <p className="mt-1 text-xs text-subtle-foreground">
            {`GitHub lists the first ${first.commits.length}; the pull request shows them all.`}
          </p>
        )}
      </section>
      <section aria-label="Files changed">
        <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          Files changed
          <span className="font-normal text-subtle-foreground tabular-nums">
            {first.totalFiles}
          </span>
        </h2>
        <PrCompareFiles files={first.files} />
        {Array.from({ length: pages - 1 }, (_, index) => (
          <FilePage key={index + 2} {...props} page={index + 2} />
        ))}
        <MoreFiles {...props} pages={pages} onMore={() => setPages(pages + 1)} />
      </section>
    </div>
  );
}

function CommitRow(props: { commit: ForgeCommit }) {
  const [subject = "", ...rest] = props.commit.message.split("\n");
  const body = rest.join("\n").trim();
  return (
    <li className="flex gap-3 py-2">
      <PersonAvatar name={props.commit.author} url={props.commit.authorAvatarUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-ui text-foreground">{subject}</span>
          <span className="ml-auto shrink-0 font-mono text-xs text-subtle-foreground">
            {props.commit.sha.slice(0, 7)}
          </span>
        </div>
        <div className="text-xs text-subtle-foreground">
          {props.commit.author} · <RelativeTime at={props.commit.date} />
        </div>
        {body && <Prose text={body} className="mt-1 text-ui text-muted-foreground" />}
      </div>
    </li>
  );
}

function FilePage(props: {
  project: string;
  base: string;
  head: { owner: string; branch: string };
  page: number;
}) {
  const page = useCompare(props.project, props.base, props.head, props.page);
  if (page.error)
    return <p className="mt-2 text-ui text-muted-foreground">{readFailureText(page.error)}</p>;
  return page.data ? (
    <div className="mt-2">
      <PrCompareFiles files={page.data.files} />
    </div>
  ) : null;
}

/** "Show more files" while the last page read names a next one. */
function MoreFiles(props: {
  project: string;
  base: string;
  head: { owner: string; branch: string };
  first: ForgeCompare;
  pages: number;
  onMore(): void;
}) {
  const last = useCompare(props.project, props.base, props.head, props.pages);
  const next = props.pages === 1 ? props.first.nextPage : last.data?.nextPage;
  if (!next) return null;
  const shown = Math.min(props.pages * 25, props.first.totalFiles);
  return (
    <div className="mt-2 flex items-center gap-2 text-xs text-subtle-foreground">
      {`${shown} of ${props.first.totalFiles} files`}
      <Button size="xs" variant="ghost" onClick={props.onMore}>
        Show more files
      </Button>
    </div>
  );
}
