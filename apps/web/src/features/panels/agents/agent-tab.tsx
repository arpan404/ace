import {
  useAgent,
  useAgentTree,
  useIntentSender,
  useItem,
  useSidebarThread,
} from "@ace/client-react";
import type { Agent } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";
import {
  agentName,
  agentStatusLabel,
  describeActivity,
  formatAgo,
  formatSpan,
  isRunning,
  providerNames,
} from "@ace/ui-core";
import { ArrowLeftIcon, ArrowUpRightIcon, RobotIcon, StopIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Suspense, useEffect, useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { ProviderIconTip } from "@/components/ui/provider-icons.tsx";
import { SkeletonText } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/cn.ts";
import { keymap } from "@/lib/keymap.ts";
import { useNow } from "@/lib/time.ts";
import { useWorkspaceActions, type TabViewProps } from "@/lib/workspace/index.ts";
import { AgentStatusMark } from "./agent-status.tsx";
import { countSubagents, findAgentNode, stopLabel } from "./subagents.ts";
import { useThreadParts } from "./thread-parts.ts";

/**
 * One agent of the thread's tree as a tab: who it is and what it is doing, who delegated it
 * and what it was asked, its own transcript (read only), and, when ace can reach it, a scoped
 * follow-up. Back to agents returns to the tree.
 */
export function AgentTab(props: TabViewProps) {
  const agentId = props.tab.id;
  const agent = useAgent(props.scope, agentId);
  const actions = useWorkspaceActions(props.scope);
  const name = agent ? agentName(agent) : undefined;
  // The strip shows the agent's name, before this tab's code loads next time too.
  useEffect(() => {
    if (name && props.tab.title !== name) actions.update(props.tab.key, { title: name });
  }, [name, props.tab.title, props.tab.key, actions]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-1.5">
        <Button size="sm" variant="ghost" onClick={() => actions.open({ kind: "agents" })}>
          <ArrowLeftIcon aria-hidden size={14} />
          Back to agents
          <Kbd keys={keymap.agents.keys} />
        </Button>
        <span className="flex-1" />
        {agent && <StopAgent threadId={props.scope} agent={agent} />}
      </div>
      {agent ? (
        <AgentDetail threadId={props.scope} agent={agent} />
      ) : (
        <EmptyState
          icon={RobotIcon}
          title="This agent isn't in the loaded thread"
          description="It may belong to older history that hasn't loaded, or to a thread this tab no longer shows. The agent tree lists every agent the thread has now."
        />
      )}
    </div>
  );
}

/**
 * Stop: it stops the agent and everything under it, so it says how many subagents go with it
 * and, when any do, asks before stopping them all.
 */
function StopAgent(props: { threadId: string; agent: Agent }) {
  const stop = useIntentSender();
  const tree = useAgentTree(props.threadId);
  const [asking, setAsking] = useState(false);
  if (props.agent.origin === "root" || !isRunning(props.agent)) return null;
  const node = tree && findAgentNode(tree, props.agent.id);
  const subagents = node ? countSubagents(node) : 0;
  const label = stopLabel(agentName(props.agent), subagents);
  const stopping = stop.intent?.state === "pending";
  const send = () => {
    setAsking(false);
    void stop
      .send({
        type: "thread.interrupt",
        threadId: ThreadId.parse(props.threadId),
        agentId: props.agent.id,
        cascade: true,
      })
      .catch(() => undefined);
  };
  const button = (
    <Button
      size="sm"
      variant="ghost"
      disabled={stopping}
      aria-label={stopping ? undefined : label}
      onClick={subagents ? undefined : send}
    >
      <StopIcon aria-hidden size={14} weight="fill" />
      {stopping ? "Stopping…" : "Stop"}
    </Button>
  );
  return (
    <>
      {stop.intent?.state === "failed" && (
        <span role="alert" className="truncate text-xs text-status-failed">
          Couldn't stop: {stop.intent.error ?? "refused"}
        </span>
      )}
      {subagents ? (
        <Popover open={asking} onOpenChange={setAsking}>
          <Tip label={label}>
            <PopoverTrigger render={button} />
          </Tip>
          <PopoverContent align="end" className="w-[260px]">
            <PopoverTitle className="text-ui font-medium">{label}?</PopoverTitle>
            <PopoverDescription className="mt-1 text-sm text-muted-foreground">
              Their work so far stays in the thread.
            </PopoverDescription>
            <div className="mt-3 flex justify-end gap-2">
              <PopoverClose render={<Button size="sm" variant="ghost" />}>Cancel</PopoverClose>
              <Button size="sm" variant="danger" onClick={send}>
                Stop all
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      ) : (
        <Tip label={label}>{button}</Tip>
      )}
    </>
  );
}

const fidelityNotes: Record<Agent["fidelity"], string | undefined> = {
  full: undefined,
  summary: "shares only how this subagent started and ended, not its steps.",
  placeholder: "shares only the call that started this subagent.",
};

function AgentDetail(props: { threadId: string; agent: Agent }) {
  const { agent } = props;
  const now = useNow();
  const { AgentTranscript } = useThreadParts();
  const tool = useItem(
    props.threadId,
    agent.status.state === "working" && agent.status.itemId ? agent.status.itemId : "",
  );
  const status = agentStatusLabel(agent.status);
  const running = isRunning(agent);
  const end = agent.endedAt ?? (running ? Math.max(now, agent.createdAt) : agent.createdAt);
  const activity = describeActivity(
    agent.status,
    tool?.type === "tool_call" ? tool.call.title : undefined,
  );
  const facts = [
    agent.model,
    agent.role && agent.role !== agent.name ? agent.role : undefined,
    `started ${formatAgo(agent.createdAt, Math.max(now, agent.createdAt))}`,
    `${running ? "running for" : "ran for"} ${formatSpan(agent.createdAt, end)}`,
    agent.background ? "in the background" : undefined,
  ].filter(Boolean);
  const fidelity = fidelityNotes[agent.fidelity];
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[736px] flex-col gap-4 px-5 pt-4 pb-8">
          <header className="flex flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <ProviderIconTip
                provider={agent.native.provider}
                acpAgentId={agent.native.acpAgentId}
                size={16}
                className="shrink-0"
              />
              <h2 className="min-w-0 truncate text-md font-medium">{agentName(agent)}</h2>
              <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
                <AgentStatusMark status={agent.status} />
                {status.label}
              </span>
            </div>
            <p
              className={cn(
                "text-sm text-muted-foreground",
                agent.status.state === "failed" && "text-status-failed",
              )}
            >
              {activity.charAt(0).toUpperCase() + activity.slice(1)}
            </p>
            <p className="text-xs text-subtle-foreground tabular-nums">{facts.join(" · ")}</p>
          </header>
          {agent.origin !== "root" && <Delegation threadId={props.threadId} agent={agent} />}
          {fidelity && (
            <p className="text-sm text-muted-foreground">
              {providerNames[agent.native.provider]} {fidelity}
            </p>
          )}
          <section aria-label="Transcript" className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-subtle-foreground">
              {agent.childThreadId ? "Its thread" : "Transcript"}
            </h3>
            {AgentTranscript ? (
              <Suspense fallback={<SkeletonText lines={3} />}>
                {agent.childThreadId ? (
                  <AgentTranscript threadId={agent.childThreadId} />
                ) : (
                  <AgentTranscript threadId={props.threadId} agentId={agent.id} />
                )}
              </Suspense>
            ) : (
              <p className="text-sm text-muted-foreground">
                The transcript shows beside its thread's conversation.
              </p>
            )}
          </section>
        </div>
      </div>
      <FollowUp threadId={props.threadId} agent={agent} />
    </>
  );
}

/** Who started this agent, with what, and where its own thread is when it has one. */
function Delegation(props: { threadId: string; agent: Agent }) {
  const { agent } = props;
  const parent = useAgent(props.threadId, agent.parentId ?? "");
  const spawn = useItem(props.threadId, agent.spawnedBy ?? "");
  const child = useSidebarThread(agent.childThreadId ?? "");
  const call = spawn?.type === "tool_call" ? spawn.call : undefined;
  const detail = call?.detail.kind === "agent.spawn" ? call.detail : undefined;
  const by = parent ? agentName(parent) : "Its parent agent";
  const how =
    agent.origin === "ace"
      ? "delegated it through ace, as a thread of its own"
      : `started it with ${providerNames[agent.native.provider]}'s own subagent tool`;
  return (
    <section
      aria-label="Delegation"
      className="flex flex-col gap-1.5 rounded-card bg-muted px-3.5 py-3 text-sm"
    >
      <p className="text-muted-foreground">
        <b className="font-medium text-foreground">{by}</b> {how}
        {detail?.agentType ? ` (${detail.agentType})` : ""}.
      </p>
      {(detail?.description ?? call?.title) && (
        <p className="text-foreground">{detail?.description ?? call?.title}</p>
      )}
      {detail?.prompt && <Prompt text={detail.prompt} />}
      {agent.childThreadId && child && (
        <Link
          to="/t/$threadId"
          params={{ threadId: agent.childThreadId }}
          className={cn(buttonVariants({ size: "sm", variant: "ghost" }), "-ml-2.5 self-start")}
        >
          Open its thread
          <ArrowUpRightIcon aria-hidden size={12} />
        </Link>
      )}
    </section>
  );
}

/** The delegated prompt, clamped to four lines until asked for in full. */
function Prompt(props: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = props.text.length > 320 || props.text.split("\n").length > 4;
  return (
    <div className="flex flex-col items-start gap-1">
      <p
        className={cn(
          "font-mono text-[12px] leading-5 whitespace-pre-wrap text-muted-foreground",
          long && !open && "line-clamp-4",
        )}
      >
        {props.text}
      </p>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="rounded-xs text-xs text-subtle-foreground outline-none hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)]"
        >
          {open ? "Show less" : "Show the whole prompt"}
        </button>
      )}
    </div>
  );
}

/**
 * A follow-up to this agent alone, in the thread composer's own shape. ace reaches an agent it
 * delegated as a thread of its own (a queued message to that thread); a provider's own subagent
 * takes instructions only from its parent, so there the composer is off and says where to ask.
 */
function FollowUp(props: { threadId: string; agent: Agent }) {
  const { agent } = props;
  const { AgentComposer } = useThreadParts();
  const noteId = useId();
  if (agent.origin === "root") return null;
  const name = agentName(agent);
  const target = agent.childThreadId;
  const note = target
    ? "Goes to this agent's own thread, not the main conversation."
    : `${providerNames[agent.native.provider]} subagents take instructions only from the agent that started them. Ask the main agent in the thread's composer.`;
  return (
    <div className="shrink-0 px-4 pt-2 pb-4">
      <div className="mx-auto flex w-full max-w-[736px] flex-col gap-2">
        {AgentComposer && (
          <AgentComposer
            threadId={props.threadId}
            agentId={agent.id}
            target={target}
            label={`Message ${name}`}
            placeholder={`Follow up with ${name} only`}
            unavailable={
              target
                ? undefined
                : { reason: note, describedBy: noteId, short: "Ask the main agent instead" }
            }
          />
        )}
        <p id={noteId} className="px-4 text-xs leading-4 text-subtle-foreground">
          {note}
        </p>
      </div>
    </div>
  );
}
