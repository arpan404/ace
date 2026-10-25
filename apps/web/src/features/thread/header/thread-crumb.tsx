import { useAgent, useSidebarThread, useThreadMeta } from "@ace/client-react";
import { agentName, projectBadge } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { ProjectMark } from "@/components/project-mark.tsx";
import { MachineLabel } from "@/components/ui/machine-label.tsx";
import { useMachineSearch } from "@/lib/machine-routes.ts";
import { useScopedMachine } from "@/lib/machines.ts";
import { useProjectName } from "@/lib/projects.ts";

/**
 * Where a thread sits, before its title in the header: its project's badge and name, or, for a
 * child ace delegated, the parent thread as a link. A fork is a thread of its own: it names its
 * project, and its transcript says where it was forked from.
 */
export function ThreadCrumb(props: { threadId: string }) {
  const meta = useThreadMeta(props.threadId);
  const parent = meta?.delegatedBy;
  if (parent)
    return (
      <>
        <MachineCrumb />
        <ParentCrumb threadId={parent} />
      </>
    );
  return meta ? <ProjectCrumb workspaceId={meta.workspaceId} /> : null;
}

/** A thread's project, before its title: its badge and name, after its machine when not this one. */
export function ProjectCrumb(props: { workspaceId: string }) {
  const name = useProjectName()(props.workspaceId);
  return (
    <>
      <MachineCrumb />
      <ProjectMark id={props.workspaceId} badge={projectBadge({ id: props.workspaceId, name })} />
      <span className="truncate">{name}</span>
    </>
  );
}

/**
 * Work on another machine (ADR 0102) names that machine first, the way every machine is named:
 * its mark and name. Nothing on this window's own machine, so a single machine never shows one.
 */
function MachineCrumb() {
  const machine = useScopedMachine();
  if (!machine) return null;
  return (
    <>
      <MachineLabel name={machine.name} icon={machine.icon} primary={false} />
      <span aria-hidden className="text-subtle-foreground">
        /
      </span>
    </>
  );
}

/**
 * A provider subagent's parent, before its name: the thread when the thread's main agent started
 * it, else the subagent that did, at its own view.
 */
export function SubagentCrumb(props: { threadId: string; parentAgentId: string }) {
  const parent = useAgent(props.threadId, props.parentAgentId);
  const search = useMachineSearch();
  return (
    <>
      <MachineCrumb />
      {!parent || parent.origin === "root" ? (
        <ParentCrumb threadId={props.threadId} />
      ) : (
        <Link
          to="/t/$threadId/agents/$agentId"
          params={{ threadId: props.threadId, agentId: parent.id }}
          search={search}
          className={crumbLink}
        >
          {agentName(parent)}
        </Link>
      )}
    </>
  );
}

const crumbLink =
  "focus-ring truncate rounded-sm underline-offset-2 hover:text-foreground hover:underline [-webkit-app-region:no-drag]";

/** A thread that came out of another names it first, as a link back. */
export function ParentCrumb(props: { threadId: string }) {
  const parent = useSidebarThread(props.threadId);
  const search = useMachineSearch();
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: props.threadId }}
      search={search}
      className={crumbLink}
    >
      {parent?.title ?? "Parent thread"}
    </Link>
  );
}
