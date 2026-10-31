import { useSidebarThread } from "@ace/client-react";
import { historyDate, projectBadge } from "@ace/ui-core";
import { GitMergeIcon, GitPullRequestIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import { ProjectMark } from "./row-parts.tsx";
import { useThreadCard } from "./use-thread-card.ts";
import type { SearchHit } from "./use-panel-search.ts";

// A hairline row whose hover wash overhangs the page's gutter, so its text sits on the edge.
const row =
  "-mx-2.5 grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3.5 rounded-md px-2.5 py-2 text-left outline-none transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function Row(props: {
  threadId: string;
  title: string;
  label: string;
  sub: ReactNode;
  left?: ReactNode;
  at: number;
}) {
  const now = useNow();
  return (
    <li className="border-b border-border">
      <Link
        to="/t/$threadId"
        params={{ threadId: props.threadId }}
        aria-label={props.label}
        data-history-row=""
        className={row}
      >
        <span className="min-w-0">
          <span className="block truncate text-ui font-medium text-foreground">{props.title}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-meta text-subtle-foreground">
            {props.sub}
          </span>
        </span>
        <span className="flex items-center gap-1 text-meta text-muted-foreground tabular-nums">
          {props.left}
        </span>
        <span className="w-16 text-right text-meta text-subtle-foreground tabular-nums">
          {historyDate(props.at, now)}
        </span>
      </Link>
    </li>
  );
}

/**
 * A settled thread in History: its title, project and branch, what it left behind (the PR with
 * its merge glyph, or the lines added and removed) and when it last worked. It opens the
 * thread. A thread the list hasn't paged in shows the daemon's search hit for it instead.
 */
export function HistoryRow(props: { id: string; at: number; hit?: SearchHit | undefined }) {
  const listed = useSidebarThread(props.id) !== undefined;
  if (!listed && props.hit) return <HitRow hit={props.hit} />;
  return <ListedRow id={props.id} at={props.at} />;
}

function ListedRow(props: { id: string; at: number }) {
  const data = useThreadCard(props.id, true);
  if (!data) return null;
  const { card, entry } = data;
  const left =
    card.pr !== undefined ? (
      <>
        {card.prState === "merged" ? (
          <GitMergeIcon aria-hidden size={12} />
        ) : (
          <GitPullRequestIcon aria-hidden size={12} />
        )}
        {card.pr}
      </>
    ) : card.diff ? (
      <>
        <span className="text-diff-add">+{card.diff.added}</span>
        <span className="text-diff-del">−{card.diff.removed}</span>
      </>
    ) : undefined;
  return (
    <Row
      threadId={entry.id}
      title={card.title}
      label={[card.title, card.project, card.branch?.name, card.pr].filter(Boolean).join(", ")}
      at={props.at}
      left={left}
      sub={
        <>
          <ProjectMark id={entry.workspaceId} badge={card.badge} />
          <span className="max-w-[45%] shrink-0 truncate">{card.project}</span>
          {card.branch && (
            <>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate font-mono">{card.branch.name}</span>
            </>
          )}
        </>
      }
    />
  );
}

function HitRow(props: { hit: SearchHit }) {
  const { hit } = props;
  const name = useProjectName()(hit.workspaceId);
  return (
    <Row
      threadId={hit.threadId}
      title={hit.threadTitle}
      label={`${hit.threadTitle}, ${name}`}
      at={hit.createdAt}
      sub={
        <>
          <ProjectMark id={hit.workspaceId} badge={projectBadge({ id: hit.workspaceId, name })} />
          <span className="min-w-0 truncate">{name}</span>
        </>
      }
    />
  );
}
