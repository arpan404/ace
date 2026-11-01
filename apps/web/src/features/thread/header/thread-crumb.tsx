import { useAgent, useSidebarThread, useThreadMeta } from "@ace/client-react";
import { agentName } from "@ace/ui-core";
import { ChatCircleIcon, FolderSimpleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useMachineSearch } from "@/lib/machine-routes.ts";
import { useScopedMachine } from "@/lib/machines.ts";
import { useIsChatThread, useProjectName, type ChatTestEntry } from "@/lib/projects.ts";

/**
 * A child ace delegated names its parent thread before its title, as a link back. Any other
 * thread has no crumb: its project shows as the folder glyph before its title (`ThreadMark`).
 * A fork is a thread of its own; its transcript says where it was forked from.
 */
export function ThreadCrumb(props: { threadId: string }) {
  const parent = useThreadMeta(props.threadId)?.delegatedBy;
  return parent ? <ParentCrumb threadId={parent} /> : null;
}

/** Whether the thread's header shows a parent before its title (`ThreadCrumb`). */
export function useHasParentCrumb(threadId: string): boolean {
  return useThreadMeta(threadId)?.delegatedBy !== undefined;
}

/**
 * The glyph before a thread's title in the top bar: its project's folder, named in its tooltip
 * and to assistive tech, after the machine when the work runs on another one (ADR 0102). A chat
 * has no project (ADR 0099): it shows the chat bubble and is named a chat.
 */
export function ProjectGlyph(props: { thread: ChatTestEntry }) {
  const name = useProjectName()(props.thread.workspaceId);
  const chat = useIsChatThread()(props.thread);
  const machine = useScopedMachine();
  const what = chat ? "Chat" : name;
  const said = machine ? `${machine.name} / ${what}` : what;
  return (
    <Tip label={said}>
      <span role="img" aria-label={chat ? said : `Project ${said}`} className="inline-flex">
        <Icon icon={chat ? ChatCircleIcon : FolderSimpleIcon} />
      </span>
    </Tip>
  );
}

/**
 * A provider subagent's parent, before its name: the thread when the thread's main agent started
 * it, else the subagent that did, at its own view.
 */
export function SubagentCrumb(props: { threadId: string; parentAgentId: string }) {
  const parent = useAgent(props.threadId, props.parentAgentId);
  const search = useMachineSearch();
  // A subagent reads `thread / subagent`, wherever it runs: never a machine first.
  return (
    <>
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
    <ParentCrumbLink
      threadId={props.threadId}
      title={parent?.title ?? "Parent thread"}
      search={search}
    />
  );
}

/**
 * The link back to a parent thread, from what was read about it: it reads no machine itself, so
 * a view on another machine (a child delegated there) can show its parent on this one.
 */
export function ParentCrumbLink(props: {
  threadId: string;
  title: string;
  search: { machine?: string };
}) {
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: props.threadId }}
      search={props.search}
      className={crumbLink}
    >
      {props.title}
    </Link>
  );
}
