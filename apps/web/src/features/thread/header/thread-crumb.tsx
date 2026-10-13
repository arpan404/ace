import { useAgent, useSidebarThread, useThreadMeta } from "@ace/client-react";
import { agentName, projectBadge } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { ProjectMark } from "@/components/project-mark.tsx";
import { useProjectMetadata, useProjectName } from "@/lib/projects.ts";

/**
 * Where a thread sits, before its title in the header: its project's badge and name, or, for a
 * thread that came out of another (a fork, or a child ace delegated), that parent thread as a link.
 */
export function ThreadCrumb(props: { threadId: string }) {
  const meta = useThreadMeta(props.threadId);
  const parent = meta?.lineage?.parentThreadId ?? meta?.delegatedBy;
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

/**
 * A provider subagent's parent, before its name: the thread when the thread's main agent started
 * it, else the subagent that did, at its own view.
 */
export function SubagentCrumb(props: { threadId: string; parentAgentId: string }) {
  const parent = useAgent(props.threadId, props.parentAgentId);
  if (!parent || parent.origin === "root") return <ParentCrumb threadId={props.threadId} />;
  return (
    <Link
      to="/t/$threadId/agents/$agentId"
      params={{ threadId: props.threadId, agentId: parent.id }}
      className={crumbLink}
    >
      {agentName(parent)}
    </Link>
  );
}

const crumbLink =
  "focus-ring truncate rounded-sm underline-offset-2 hover:text-foreground hover:underline [-webkit-app-region:no-drag]";

function ParentCrumb(props: { threadId: string }) {
  const parent = useSidebarThread(props.threadId);
  return (
    <Link to="/t/$threadId" params={{ threadId: props.threadId }} className={crumbLink}>
      {parent?.title ?? "Parent thread"}
    </Link>
  );
}
