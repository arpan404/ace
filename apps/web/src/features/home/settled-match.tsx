import { useSidebarThread } from "@ace/client-react";
import { formatAge, projectBadge } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import type { SearchHit } from "./use-panel-search.ts";
import { ProjectMark } from "./row-parts.tsx";
import { SettledRow } from "./settled-row.tsx";
import { useOpenHere } from "./thread-row.tsx";

/**
 * A one-line thread (settled, in Recent, or among search matches): its settled row once the list
 * has it, else the daemon's search hit for it (an older thread not paged in yet), which opens
 * the thread the same way.
 */
export function SettledMatch(props: {
  id: string;
  hit: SearchHit | undefined;
  leaving?: boolean | undefined;
  /** False for finished work Recent lists that isn't settled. */
  settled?: boolean | undefined;
  inProject?: boolean | undefined;
}) {
  const listed = useSidebarThread(props.id) !== undefined;
  if (listed || !props.hit)
    return (
      <SettledRow
        threadId={props.id}
        leaving={props.leaving}
        settled={props.settled}
        inProject={props.inProject}
      />
    );
  return <HitRow hit={props.hit} />;
}

function HitRow(props: { hit: SearchHit }) {
  const { hit } = props;
  const name = useProjectName()(hit.workspaceId);
  const now = useNow();
  const current = useOpenHere(hit.threadId, undefined);
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: hit.threadId }}
      aria-label={`${hit.threadTitle}. Settled, project ${name}`}
      data-row-focus=""
      draggable={false}
      className={cn(
        "flex h-[30px] w-full items-center gap-2 rounded-md px-2.5 text-left text-ui outline-none transition-colors duration-(--motion-fast) focus-ring-inset focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        current ? "bg-active text-foreground" : "text-muted-foreground hover:bg-hover",
      )}
    >
      <ProjectMark
        id={hit.workspaceId}
        badge={projectBadge({ id: hit.workspaceId, name })}
        quiet={!current}
      />
      <span className="min-w-0 flex-1 truncate leading-5">{hit.threadTitle}</span>
      <span className="shrink-0 text-meta text-faint-foreground tabular-nums">
        {formatAge(hit.createdAt, now)}
      </span>
    </Link>
  );
}
