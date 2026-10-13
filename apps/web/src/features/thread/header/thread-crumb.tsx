import { useSidebarThread, useThreadMeta } from "@ace/client-react";
import { projectBadge } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { ProjectMark } from "@/components/project-mark.tsx";
import { useProjectMetadata, useProjectName } from "@/lib/projects.ts";

/**
 * Where a thread sits, before its title in the header: its project's badge and name, or, for a
 * thread that came out of another (a fork or a delegated child), that parent thread as a link.
 */
export function ThreadCrumb(props: { threadId: string }) {
  const meta = useThreadMeta(props.threadId);
  const parent = meta?.lineage?.parentThreadId;
  if (parent) return <ParentCrumb threadId={parent} />;
  return meta ? <ProjectCrumb workspaceId={meta.workspaceId} /> : null;
}

function ProjectCrumb(props: { workspaceId: string }) {
  const name = useProjectName()(props.workspaceId);
  const project = useProjectMetadata()(props.workspaceId);
  return (
    <>
      <ProjectMark
        badge={projectBadge({ id: props.workspaceId, name })}
        icon={project?.icon ?? project?.defaultIcon}
      />
      <span className="truncate">{name}</span>
    </>
  );
}

function ParentCrumb(props: { threadId: string }) {
  const parent = useSidebarThread(props.threadId);
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: props.threadId }}
      className="focus-ring truncate rounded-sm underline-offset-2 hover:text-foreground hover:underline [-webkit-app-region:no-drag]"
    >
      {parent?.title ?? "Parent thread"}
    </Link>
  );
}
