import { useAgent, useIntentSender, useItem, useSidebarThread } from "@ace/client-react";
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
import { ArrowLeftIcon, ArrowUpRightIcon, RobotIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Suspense, useEffect, useState, type KeyboardEvent } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { ProviderIconTip } from "@/components/ui/provider-icons.tsx";
import { SkeletonText } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { keymap } from "@/lib/keymap.ts";
import { useNow } from "@/lib/time.ts";
import { useWorkspaceActions, type TabViewProps } from "@/lib/workspace/index.ts";
import { AgentStatusMark } from "./agent-status.tsx";
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

function StopAgent(props: { threadId: string; agent: Agent }) {
  const stop = useIntentSender();
  if (props.agent.origin === "root" || !isRunning(props.agent)) return null;
  const stopping = stop.intent?.state === "pending";
  return (
    <>
      {stop.intent?.state === "failed" && (
        <span role="alert" className="truncate text-xs text-status-failed">
          Couldn't stop: {stop.intent.error ?? "refused"}
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={stopping}
        onClick={() =>
          void stop
            .send({
              type: "thread.interrupt",
              threadId: ThreadId.parse(props.threadId),
              agentId: props.agent.id,
              cascade: true,
            })
            .catch(() => undefined)
        }
      >
        {stopping ? "Stopping…" : "Stop"}
      </Button>
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
 * A follow-up to this agent alone. ace reaches an agent it delegated as a thread of its own
 * (a message to that thread); a provider's own subagent takes instructions only from its parent.
 */
function FollowUp(props: { threadId: string; agent: Agent }) {
  const { agent } = props;
  const [text, setText] = useState("");
  const sender = useIntentSender();
  const name = agentName(agent);
  if (agent.origin === "root") return null;
  const target = agent.childThreadId;
  const sending = sender.intent?.state === "pending";
  const send = () => {
    const message = text.trim();
    if (!target || !message || sending) return;
    void sender
      .send({
        type: "thread.send",
        threadId: ThreadId.parse(target),
        input: [{ type: "text", text: message }],
        delivery: "queue",
      })
      .then(
        () => setText(""),
        () => undefined,
      );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
  };
  return (
    <div className="shrink-0 border-t px-3 py-3">
      <div className="mx-auto flex w-full max-w-[736px] flex-col gap-2 rounded-[14px] bg-secondary px-3.5 pt-3 pb-2.5">
        <textarea
          aria-label={`Message ${name}`}
          rows={2}
          value={text}
          disabled={!target}
          placeholder={
            target ? `Follow up with ${name} only` : `${name} can't take messages from here`
          }
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className="block w-full resize-none bg-transparent text-ui leading-5 text-foreground outline-none placeholder:text-subtle-foreground disabled:cursor-not-allowed"
        />
        <div className="flex min-h-7 items-center gap-2">
          <p id={`${agent.id}-follow-up`} className="min-w-0 flex-1 text-xs text-subtle-foreground">
            {target
              ? "Goes to this agent's own thread, not the main conversation."
              : `${providerNames[agent.native.provider]} subagents take instructions only from the agent that started them. Ask the main agent in the thread's composer.`}
          </p>
          {sender.intent?.state === "failed" && (
            <span role="alert" className="shrink-0 text-xs text-status-failed">
              Not sent: {sender.intent.error ?? "refused"}
            </span>
          )}
          <Button
            size="sm"
            variant="primary"
            aria-describedby={`${agent.id}-follow-up`}
            disabled={!target || !text.trim() || sending}
            onClick={send}
          >
            {sending && <Spinner />}
            Send
            <Kbd keys={keymap.send.keys} variant="on-primary" />
          </Button>
        </div>
      </div>
    </div>
  );
}
